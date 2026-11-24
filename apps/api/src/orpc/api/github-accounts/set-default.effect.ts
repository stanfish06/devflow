import { Effect } from 'effect'

import { setDefaultGithubAccount } from '../../../effects/github-accounts/github-accounts'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Choose the caller's default GitHub account, or null for the host's own gh login. */
export const setDefaultGithubAccountProcedure = effectOrpcBaseOrganizationRequired.githubAccounts.setDefault.effect(
	function* ({ input, context, errors }) {
		return yield* setDefaultGithubAccount({
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
			accountId: input.accountId,
		}).pipe(
			Effect.catchTags({
				GithubAccountNotFound: () =>
					Effect.fail(errors.NOT_FOUND({ data: { message: 'GitHub account not found' } })),
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)
	},
)
