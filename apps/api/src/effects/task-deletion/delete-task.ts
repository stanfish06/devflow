import { tasks } from '@devflow/db/tables/tasks'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { deleteTasksInTransaction, deleteTaskStreams } from './delete-tasks'
import { NotTaskOwner, TaskNotFound } from './errors'

export interface DeleteTaskInput {
	readonly organizationId: string
	readonly userId: string
	readonly taskId: string
}

/**
 * Permanently delete one task the caller owns. The owner is re-read under a row lock, the way
 * `hosts.delete` re-checks eligibility, so a concurrent reassignment can't slip a delete through.
 * The lock also holds off new sessions for the task (their FK check waits on it), so every
 * session is deleted with it.
 */
export const deleteTask = Effect.fn('task_deletion.delete_task')(function* (input: DeleteTaskInput) {
	const postgres = yield* PostgresDb
	const { sessionIds } = yield* postgres
		.transaction((transaction) =>
			Effect.gen(function* () {
				const [task] = yield* transaction.query(
					transaction.client
						.select({ ownerUserId: tasks.resource_owner_user_id })
						.from(tasks)
						.where(and(eq(tasks.id, input.taskId), eq(tasks.organization_id, input.organizationId)))
						.for('update'),
				)
				if (task === undefined) return yield* Effect.fail(new TaskNotFound({ taskId: input.taskId }))
				if (task.ownerUserId !== input.userId)
					return yield* Effect.fail(new NotTaskOwner({ taskId: input.taskId, userId: input.userId }))
				return yield* deleteTasksInTransaction(transaction, {
					organizationId: input.organizationId,
					taskIds: [input.taskId],
				})
			}),
		)
		.pipe(
			Effect.tapErrorTag('PostgresDbQueryError', (error) =>
				Effect.logError('Task deletion query failed', error).pipe(Effect.annotateLogs({ ...input })),
			),
			Effect.tapErrorTag('PostgresDbTransactionError', (error) =>
				Effect.logError('Task deletion transaction failed', error).pipe(Effect.annotateLogs({ ...input })),
			),
		)

	// After commit, and off the request path: the rows are already gone either way.
	yield* Effect.forkDetach(
		deleteTaskStreams({ organizationId: input.organizationId, taskIds: [input.taskId], sessionIds }),
	)
	return { taskId: input.taskId }
})
