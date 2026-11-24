import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { sessions } from '@devflow/db/tables/sessions'
import { userSettings } from '@devflow/db/tables/user-settings'
import { and, eq } from 'drizzle-orm'
import { Data, Effect, type Redacted } from 'effect'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { tokenCipherContext, type GithubAccountActor } from './github-accounts'
import { TokenCipher } from './token-cipher'

/** The daemon asking: a registration of one user's host in one organization. */
export interface GithubAccountDaemon extends GithubAccountActor {
	readonly hostId: string
}

/**
 * The session doesn't exist, or wasn't created by this daemon's user on this host (the two are
 * indistinguishable on purpose).
 */
export class GithubSessionNotFound extends Data.TaggedError('GithubSessionNotFound')<{
	readonly sessionId: string
}> {}

/**
 * Which identity a session's agent uses: an account with its decrypted token, or the host's own gh
 * login when none is chosen (today's behaviour).
 */
export type GithubAccountResolution = Data.TaggedEnum<{
	Account: {
		readonly accountId: string
		readonly login: string
		readonly name: string | null
		readonly email: string
		readonly token: Redacted.Redacted<string>
	}
	HostLogin: {}
}>

export const GithubAccountResolution = Data.taggedEnum<GithubAccountResolution>()

/**
 * Which GitHub account a session's agent acts as. Resolution runs through the session creator's own
 * choices only, so it is always one of their accounts:
 *
 *   your default (user_settings.default_github_account_id) → the host's own gh login
 *
 * (Task and project levels come first once they exist.) An account whose token GitHub has since
 * rejected is still returned: the run must fail as that account, never fall back to another one.
 */
export const resolveGithubAccountForSession = Effect.fn('github_accounts.resolve_for_session')(function* (input: {
	readonly daemon: GithubAccountDaemon
	readonly sessionId: string
}) {
	const postgres = yield* PostgresDb
	const cipher = yield* TokenCipher
	const { daemon, sessionId } = input

	// Strictly the daemon's own sessions: its organization, its user as creator, its host.
	const [session] = yield* postgres.query(
		postgres.client
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.organization_id, daemon.organizationId),
					eq(sessions.created_by, daemon.userId),
					eq(sessions.host_id, daemon.hostId),
				),
			),
	)
	if (session === undefined) return yield* Effect.fail(new GithubSessionNotFound({ sessionId }))

	const actor: GithubAccountActor = { organizationId: daemon.organizationId, userId: daemon.userId }
	const [account] = yield* postgres.query(
		postgres.client
			.select({
				id: githubAccounts.id,
				login: githubAccounts.login,
				name: githubAccounts.name,
				noreplyEmail: githubAccounts.noreply_email,
				tokenIv: githubAccounts.token_iv,
				tokenCiphertext: githubAccounts.token_ciphertext,
			})
			.from(userSettings)
			.innerJoin(
				githubAccounts,
				and(
					eq(githubAccounts.id, userSettings.default_github_account_id),
					// The default can only ever be one of the user's own accounts; never trust that alone.
					eq(githubAccounts.organization_id, actor.organizationId),
					eq(githubAccounts.user_id, actor.userId),
				),
			)
			.where(and(eq(userSettings.organization_id, actor.organizationId), eq(userSettings.user_id, actor.userId))),
	)
	if (account === undefined) return GithubAccountResolution.HostLogin()

	const token = yield* cipher.decrypt(
		{ iv: account.tokenIv, ciphertext: account.tokenCiphertext },
		tokenCipherContext(actor),
	)
	return GithubAccountResolution.Account({
		accountId: account.id,
		login: account.login,
		name: account.name,
		email: account.noreplyEmail,
		token,
	})
})
