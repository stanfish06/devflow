import { Effect } from 'effect'

import { deleteProject } from '../../../effects/project-workspace/project-operations'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/**
 * Permanently delete a project the caller owns with all of its tasks, refusing with COUNT_CHANGED
 * when the task count moved since the confirmation. Streams are removed after commit, best effort.
 */
export const deleteProjectV2Procedure = effectOrpcBaseOrganizationRequired.projects.v2.delete.effect(function* ({
	input,
	context,
	errors,
}) {
	return yield* deleteProject({
		actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
		projectId: input.projectId,
		expectedTaskCount: input.expectedTaskCount,
	}).pipe(
		Effect.catchTags({
			ProjectsV2Disabled: () => Effect.fail(errors.FORBIDDEN()),
			ProjectMutationForbidden: () => Effect.fail(errors.FORBIDDEN()),
			ProjectNotFound: () => Effect.fail(errors.NOT_FOUND({ data: { message: 'Project not found' } })),
			CountChanged: (error) =>
				Effect.fail(errors.COUNT_CHANGED({ data: { expected: error.expected, actual: error.actual } })),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
})
