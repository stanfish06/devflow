import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { deleteArchived } from '../../../effects/task-deletion/delete-archived-tasks'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/**
 * Permanently delete every archived task the caller owns, refusing with COUNT_CHANGED when the count
 * moved since the confirmation. Streams are removed after commit, best effort.
 */
export const deleteArchivedTasksProcedure = effectOrpcBaseOrganizationRequired.tasks.deleteArchived.effect(function* ({
	input,
	context,
	errors,
}) {
	return yield* deleteArchived({
		organizationId: context.auth.organizationId,
		userId: context.auth.userId,
		expectedCount: input.expectedCount,
	}).pipe(
		Effect.catchTags({
			CountChanged: (error) =>
				Effect.fail(errors.COUNT_CHANGED({ data: { expected: error.expected, actual: error.actual } })),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
})
