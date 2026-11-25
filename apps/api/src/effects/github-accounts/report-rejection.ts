import {
	githubRejectionExcerpt,
	type GithubRejectionReason,
	type ReportGithubRejectionOutput,
} from '@devflow/api-contract/daemon/github-accounts/report-rejection'
import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { and, eq } from 'drizzle-orm'
import { Effect, Redacted } from 'effect'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { fetchGithubViewer } from './github-accounts'
import { type GithubAccountDaemon, GithubAccountResolution, resolveGithubAccountForSession } from './resolve-account'

/**
 * A daemon saw GitHub refuse one of its sessions' accounts. Decide what that means by asking GitHub
 * who the stored token belongs to:
 *
 * - 401: the token is wrong, expired or revoked. The account is marked `needs_token` (unless its
 *   token was replaced meanwhile), and the run stops with `github_token_rejected`.
 * - 200: the token is fine, so the account can't reach the repository. The account stays `ok`, and
 *   the run stops with `github_no_repo_access`.
 *
 * The daemon's text match alone never marks a token broken; at worst a false match stops a run
 * with a "no access" notice. A report about an account the session no longer resolves to (the user
 * switched, or removed it) is ignored. Scoped like `resolveToken`: only the daemon's own sessions.
 */
export const reportGithubRejection = Effect.fn('github_accounts.report_rejection')(function* (input: {
	readonly daemon: GithubAccountDaemon
	readonly sessionId: string
	readonly accountId: string
	readonly excerpt: string
}) {
	const postgres = yield* PostgresDb
	const { daemon, sessionId, accountId } = input
	const resolution = yield* resolveGithubAccountForSession({ daemon, sessionId })
	if (GithubAccountResolution.$is('HostLogin')(resolution) || resolution.accountId !== accountId) {
		yield* Effect.logInfo('Ignoring a GitHub rejection for an account the session no longer uses').pipe(
			Effect.annotateLogs({ sessionId, accountId }),
		)
		return { stop: false } satisfies ReportGithubRejectionOutput
	}

	const reason = yield* fetchGithubViewer(resolution.token).pipe(
		Effect.as<GithubRejectionReason>('github_no_repo_access'),
		Effect.catchTag('GithubTokenRejected', () => Effect.succeed<GithubRejectionReason>('github_token_rejected')),
	)
	if (reason === 'github_token_rejected') {
		yield* postgres.query(
			postgres.client
				.update(githubAccounts)
				.set({ status: 'needs_token' })
				.where(
					and(
						eq(githubAccounts.id, accountId),
						eq(githubAccounts.organization_id, daemon.organizationId),
						eq(githubAccounts.user_id, daemon.userId),
						// Only the token GitHub just rejected: a replacement written meanwhile stays `ok`.
						eq(githubAccounts.token_iv, resolution.tokenIv),
					),
				),
		)
	}

	// The daemon redacts before sending; redact again with the one secret only the server knows here.
	yield* Effect.logWarning('GitHub refused a session account; stopping the run').pipe(
		Effect.annotateLogs({
			sessionId,
			accountId,
			login: resolution.login,
			reason,
			excerpt: githubRejectionExcerpt(input.excerpt, [Redacted.value(resolution.token)]),
		}),
	)
	return { stop: true, reason, login: resolution.login } satisfies ReportGithubRejectionOutput
})
