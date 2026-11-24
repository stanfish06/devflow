import { Effect, Redacted } from 'effect'

import {
	GithubAccountResolution,
	resolveGithubAccountForSession,
} from '../../../effects/github-accounts/resolve-account'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcDaemonBase } from '../../effect-base'

/**
 * The GitHub account one of the daemon's sessions acts as, with its token. The only procedure that
 * returns a token, so it is scoped to the daemon token's own (organization, user, host): the
 * session must be one this daemon's user created on this host, or it is NOT_FOUND.
 *
 * Nothing here logs the token: it stays Redacted until it is put in the response.
 */
export const resolveGithubTokenProcedure = effectOrpcDaemonBase.githubAccounts.resolveToken.effect(function* ({
	input,
	context,
	errors,
}) {
	const resolution = yield* resolveGithubAccountForSession({
		daemon: {
			organizationId: context.auth.organizationId,
			userId: context.auth.userId,
			hostId: context.auth.hostId,
		},
		sessionId: input.sessionId,
	}).pipe(
		Effect.catchTags({
			GithubSessionNotFound: () => Effect.fail(errors.NOT_FOUND()),
			TokenStorageUnavailable: (error) =>
				Effect.logError('GitHub account tokens cannot be read', { reason: error.reason }).pipe(
					Effect.andThen(Effect.fail(errors.SERVICE_UNAVAILABLE())),
				),
			// A different key, or a tampered row. The error carries nothing worth logging.
			TokenDecryptFailed: () =>
				Effect.logError('A GitHub account token did not decrypt').pipe(
					Effect.annotateLogs({ sessionId: input.sessionId }),
					Effect.andThen(Effect.fail(errors.INTERNAL_SERVER_ERROR())),
				),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
	return GithubAccountResolution.$match(resolution, {
		HostLogin: () => ({ useHostLogin: true as const }),
		Account: (account) => ({
			accountId: account.accountId,
			login: account.login,
			name: account.name,
			email: account.email,
			token: Redacted.value(account.token),
		}),
	})
})
