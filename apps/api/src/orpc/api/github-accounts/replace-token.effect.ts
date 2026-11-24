import { Effect, Redacted } from 'effect'

import { replaceGithubAccountToken } from '../../../effects/github-accounts/github-accounts'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { GITHUB_UNREACHABLE_MESSAGE, TOKEN_REJECTED_MESSAGE, tokenStorageUnavailableMessage } from './token-errors'

/** Give one of the caller's accounts a new token for the same GitHub user. */
export const replaceGithubAccountTokenProcedure = effectOrpcBaseOrganizationRequired.githubAccounts.replaceToken.effect(
	function* ({ input, context, errors }) {
		const account = yield* replaceGithubAccountToken({
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
			accountId: input.accountId,
			token: Redacted.make(input.token),
		}).pipe(
			Effect.catchTags({
				GithubAccountNotFound: () =>
					Effect.fail(errors.NOT_FOUND({ data: { message: 'GitHub account not found' } })),
				GithubAccountMismatch: (error) =>
					Effect.fail(
						errors.BAD_REQUEST({
							data: {
								message: `This token belongs to ${error.actualLogin}, not ${error.expectedLogin}. Add it as its own account instead.`,
							},
						}),
					),
				GithubTokenRejected: () =>
					Effect.fail(errors.BAD_REQUEST({ data: { message: TOKEN_REJECTED_MESSAGE } })),
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
	},
)
