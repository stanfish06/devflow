import { Effect } from 'effect'

import { setProjectGithubAccount } from '../../../effects/github-accounts/account-choice'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/**
 * Choose the GitHub account the caller's agents act as in a project's tasks, or null to use their own
 * default. Per person, so any reader of the project may set their own.
 */
export const setProjectGithubAccountProcedure = effectOrpcBaseOrganizationRequired.projects.v2.setGithubAccount.effect(
	function* ({ input, context, errors }) {
		return yield* setProjectGithubAccount({
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
			projectId: input.projectId,
			accountId: input.accountId,
		}).pipe(
			Effect.catchTags({
				GithubProjectNotFound: () => Effect.fail(errors.NOT_FOUND({ data: { message: 'Project not found' } })),
				GithubAccountNotFound: () =>
					Effect.fail(errors.NOT_FOUND({ data: { message: 'GitHub account not found' } })),
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)
	},
)
