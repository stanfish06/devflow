import { Effect } from 'effect'

import { removeGithubAccount } from '../../../effects/github-accounts/github-accounts'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Delete one of the caller's GitHub accounts and its stored token. */
export const removeGithubAccountProcedure = effectOrpcBaseOrganizationRequired.githubAccounts.remove.effect(function* ({
	input,
	context,
	errors,
}) {
	return yield* removeGithubAccount({
		actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
		accountId: input.accountId,
	}).pipe(
		Effect.catchTags({
			GithubAccountNotFound: () =>
				Effect.fail(errors.NOT_FOUND({ data: { message: 'GitHub account not found' } })),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
})
