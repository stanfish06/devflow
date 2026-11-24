import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { and, eq, exists, ne, sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { deleteTasksInTransaction, deleteTaskStreams } from './delete-tasks'
import { CountChanged } from './errors'

export interface ArchivedTasksActor {
	readonly organizationId: string
	readonly userId: string
}

/** The caller's own archived tasks: the only ones a bulk delete may take. */
const ownArchived = (actor: ArchivedTasksActor) =>
	and(
		eq(tasks.organization_id, actor.organizationId),
		eq(tasks.resource_owner_user_id, actor.userId),
		eq(tasks.archived, true),
	)

/**
 * What "Delete all archived tasks" would remove, for its confirmation: how many archived tasks the
 * caller owns, and how many shared archived tasks it skips. A shared one is an archived task someone
 * else owns that the caller ran a session in; the Archived page lists those beside the caller's own
 * (the same "mine" scope as the sidebar), so the confirmation says how many stay.
 */
export const previewArchived = Effect.fn('task_deletion.preview_archived')(function* (actor: ArchivedTasksActor) {
	const postgres = yield* PostgresDb
	const ranASession = exists(
		postgres.client
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.organization_id, actor.organizationId),
					eq(sessions.task_id, tasks.id),
					eq(sessions.created_by, actor.userId),
				),
			),
	)
	const [counts] = yield* postgres
		.query(
			postgres.client
				.select({
					deletableCount:
						sql<number>`count(*) filter (where ${eq(tasks.resource_owner_user_id, actor.userId)})`.mapWith(
							Number,
						),
					skippedSharedCount: sql<number>`count(*) filter (where ${and(
						ne(tasks.resource_owner_user_id, actor.userId),
						ranASession,
					)})`.mapWith(Number),
				})
				.from(tasks)
				.where(and(eq(tasks.organization_id, actor.organizationId), eq(tasks.archived, true))),
		)
		.pipe(
			Effect.tapErrorTag('PostgresDbQueryError', (error) =>
				Effect.logError('Archived task preview query failed', error).pipe(Effect.annotateLogs({ ...actor })),
			),
		)
	return { deletableCount: counts?.deletableCount ?? 0, skippedSharedCount: counts?.skippedSharedCount ?? 0 }
})

/**
 * Permanently delete every archived task the caller owns. Follows `hosts.delete`: the tasks are
 * locked and counted, and if the count isn't the one the caller confirmed, nothing is deleted.
 *
 * Under the row locks the count can't drift before commit. A task unarchived or handed to someone
 * else meanwhile is re-checked after its lock is released and drops out of the count; a new session
 * on a locked task waits on its FK check and then fails. A task archived after the count is taken
 * simply isn't deleted, which never deletes more than was confirmed.
 */
export const deleteArchived = Effect.fn('task_deletion.delete_archived')(function* (
	input: ArchivedTasksActor & { readonly expectedCount: number },
) {
	const actor = { organizationId: input.organizationId, userId: input.userId }
	const postgres = yield* PostgresDb
	const deleted = yield* postgres
		.transaction((transaction) =>
			Effect.gen(function* () {
				const rows = yield* transaction.query(
					transaction.client.select({ id: tasks.id }).from(tasks).where(ownArchived(actor)).for('update'),
				)
				if (rows.length !== input.expectedCount)
					return yield* new CountChanged({ expected: input.expectedCount, actual: rows.length })
				const taskIds = rows.map((row) => row.id)
				const { sessionIds } = yield* deleteTasksInTransaction(transaction, {
					organizationId: actor.organizationId,
					taskIds,
				})
				return { taskIds, sessionIds }
			}),
		)
		.pipe(
			Effect.tapErrorTag('PostgresDbQueryError', (error) =>
				Effect.logError('Archived task deletion query failed', error).pipe(Effect.annotateLogs({ ...actor })),
			),
			Effect.tapErrorTag('PostgresDbTransactionError', (error) =>
				Effect.logError('Archived task deletion transaction failed', error).pipe(
					Effect.annotateLogs({ ...actor }),
				),
			),
		)

	// After commit, and off the request path: the rows are already gone either way.
	if (deleted.taskIds.length > 0)
		yield* Effect.forkDetach(
			deleteTaskStreams({
				organizationId: actor.organizationId,
				taskIds: deleted.taskIds,
				sessionIds: deleted.sessionIds,
			}),
		)
	return { deletedCount: deleted.taskIds.length }
})
