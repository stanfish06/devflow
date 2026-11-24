import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { previewArchived } from '../../../effects/task-deletion/delete-archived-tasks'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Count the archived tasks a bulk delete would take, and the shared ones it skips. */
export const deleteArchivedTasksPreviewProcedure =
	effectOrpcBaseOrganizationRequired.tasks.deleteArchivedPreview.effect(function* ({ context, errors }) {
		return yield* previewArchived({
			organizationId: context.auth.organizationId,
			userId: context.auth.userId,
		}).pipe(
			Effect.catchTags({
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)
	})
