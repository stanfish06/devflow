import { Effect, Redacted } from 'effect'

import { addGithubAccount } from '../../../effects/github-accounts/github-accounts'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { GITHUB_UNREACHABLE_MESSAGE, TOKEN_REJECTED_MESSAGE, tokenStorageUnavailableMessage } from './token-errors'

/** Check a pasted token with GitHub and store it, encrypted, as one of the caller's accounts. */
export const addGithubAccountProcedure = effectOrpcBaseOrganizationRequired.githubAccounts.add.effect(function* ({
	input,
	context,
	errors,
}) {
	const account = yield* addGithubAccount({
		actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
		token: Redacted.make(input.token),
	}).pipe(
		Effect.catchTags({
			GithubTokenRejected: () => Effect.fail(errors.BAD_REQUEST({ data: { message: TOKEN_REJECTED_MESSAGE } })),
			GithubUnreachable: () =>
				Effect.fail(errors.GITHUB_UNREACHABLE({ data: { message: GITHUB_UNREACHABLE_MESSAGE } })),
			TokenStorageUnavailable: (error) =>
				Effect.fail(
					errors.TOKEN_STORAGE_UNAVAILABLE({ data: { message: tokenStorageUnavailableMessage(error) } }),
				),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
	return { account }
})
