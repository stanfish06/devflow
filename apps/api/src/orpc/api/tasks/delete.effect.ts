import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { deleteTask } from '../../../effects/task-deletion/delete-task'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Permanently delete a task the caller owns. Its streams are removed after commit, best effort. */
export const deleteTaskEffectProcedure = effectOrpcBaseOrganizationRequired.tasks.delete.effect(function* ({
	input,
	context,
	errors,
}) {
	return yield* deleteTask({
		taskId: input.taskId,
		organizationId: context.auth.organizationId,
		userId: context.auth.userId,
	}).pipe(
		Effect.catchTags({
			TaskNotFound: () => Effect.fail(errors.NOT_FOUND({ data: { message: 'Task not found' } })),
			NotTaskOwner: () => Effect.fail(errors.FORBIDDEN()),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
})
