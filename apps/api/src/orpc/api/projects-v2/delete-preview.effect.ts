import { Effect } from 'effect'

import { previewProjectDelete } from '../../../effects/project-workspace/project-operations'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Count the tasks a project delete would take, for the owner's confirmation. */
export const projectDeletePreviewV2Procedure = effectOrpcBaseOrganizationRequired.projects.v2.deletePreview.effect(
	function* ({ input, context, errors }) {
		return yield* previewProjectDelete({
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
			projectId: input.projectId,
		}).pipe(
			Effect.catchTags({
				ProjectsV2Disabled: () => Effect.fail(errors.FORBIDDEN()),
				ProjectMutationForbidden: () => Effect.fail(errors.FORBIDDEN()),
				ProjectNotFound: () => Effect.fail(errors.NOT_FOUND({ data: { message: 'Project not found' } })),
				ProjectPersistenceUnavailable: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)
	},
)
