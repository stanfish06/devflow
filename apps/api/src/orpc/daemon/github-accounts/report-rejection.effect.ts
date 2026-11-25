import { Effect } from 'effect'

import { reportGithubRejection } from '../../../effects/github-accounts/report-rejection'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { GITHUB_UNREACHABLE_MESSAGE } from '../../api/github-accounts/token-errors'
import { effectOrpcDaemonBase } from '../../effect-base'

/**
 * A daemon saw GitHub refuse one of its sessions' accounts. Says whether to stop the run and why,
 * after asking GitHub about the stored token. Scoped to the daemon token's own (organization, user,
 * host), like `resolveToken`: any other session is NOT_FOUND. Never returns or logs the token.
 */
export const reportGithubRejectionProcedure = effectOrpcDaemonBase.githubAccounts.reportRejection.effect(function* ({
	input,
	context,
	errors,
}) {
	return yield* reportGithubRejection({
		daemon: {
			organizationId: context.auth.organizationId,
			userId: context.auth.userId,
			hostId: context.auth.hostId,
		},
		sessionId: input.sessionId,
		accountId: input.accountId,
		excerpt: input.excerpt,
	}).pipe(
		Effect.catchTags({
			GithubSessionNotFound: () => Effect.fail(errors.NOT_FOUND()),
			GithubUnreachable: (error) =>
				Effect.logWarning('Could not ask GitHub about a rejected session account').pipe(
					Effect.annotateLogs({ sessionId: input.sessionId, reason: error.reason, status: error.status }),
					Effect.andThen(
						Effect.fail(errors.GITHUB_UNREACHABLE({ data: { message: GITHUB_UNREACHABLE_MESSAGE } })),
					),
				),
			TokenStorageUnavailable: (error) =>
				Effect.logError('GitHub account tokens cannot be read', { reason: error.reason }).pipe(
					Effect.andThen(Effect.fail(errors.SERVICE_UNAVAILABLE())),
				),
			TokenDecryptFailed: () =>
				Effect.logError('A GitHub account token did not decrypt').pipe(
					Effect.annotateLogs({ sessionId: input.sessionId }),
					Effect.andThen(Effect.fail(errors.INTERNAL_SERVER_ERROR())),
				),
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)
})
