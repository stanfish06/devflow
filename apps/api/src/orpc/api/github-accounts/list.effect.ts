import { Effect } from 'effect'

import { listGithubAccounts } from '../../../effects/github-accounts/github-accounts'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** The caller's own GitHub accounts and their default. Tokens never leave the server here. */
export const listGithubAccountsProcedure = effectOrpcBaseOrganizationRequired.githubAccounts.list.effect(function* ({
	context,
	errors,
}) {
	return yield* listGithubAccounts({
		organizationId: context.auth.organizationId,
		userId: context.auth.userId,
	}).pipe(Effect.catchTag('PostgresDbQueryError', (error) => mapPostgresErrorToResponse(error, errors)))
})
