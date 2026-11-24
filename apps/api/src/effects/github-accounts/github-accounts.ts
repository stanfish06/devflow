import type { GithubAccount } from '@devflow/api-contract/api/github-accounts/schemas'
import { githubAccounts, type GithubAccountRow } from '@devflow/db/tables/github-accounts'
import { userSettings } from '@devflow/db/tables/user-settings'
import { and, asc, eq, sql } from 'drizzle-orm'
import { Config, Effect, Redacted } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as Schema from 'effect/Schema'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { GithubAccountMismatch, GithubAccountNotFound, GithubTokenRejected, GithubUnreachable } from './errors'
import { TokenCipher } from './token-cipher'

/** Whose accounts: every GitHub account belongs to one user in one organization. */
export interface GithubAccountActor {
	readonly organizationId: string
	readonly userId: string
}

/**
 * Bound into each token's ciphertext, so a token only decrypts for the user it was stored for, even
 * if its bytes were copied onto another row.
 */
export const tokenCipherContext = (actor: GithubAccountActor) =>
	`github_accounts:${actor.organizationId}:${actor.userId}`

/** The GitHub user a token belongs to, from `GET /user`. */
export interface GithubViewer {
	readonly id: number
	readonly login: string
	readonly name: string | null
}

const GithubViewerWire = Schema.Struct({
	id: Schema.Number,
	login: Schema.NonEmptyString,
	name: Schema.NullOr(Schema.String),
})

/**
 * Where `GET /user` goes. Its own setting rather than the GitHub App's `GITHUB_API_BASE_URL`, which
 * the local launcher points at a closed port when no App is configured.
 */
const githubApiBaseUrl = Config.URL('GITHUB_ACCOUNTS_API_BASE_URL').pipe(
	Config.withDefault(new URL('https://api.github.com')),
)

/** The account's commit email, which keeps the user's real address out of commits. */
export const noreplyEmail = (viewer: Pick<GithubViewer, 'id' | 'login'>) =>
	`${viewer.id}+${viewer.login}@users.noreply.github.com`

/** Ask GitHub who a token belongs to. A 401 means GitHub rejects the token. */
export const fetchGithubViewer = Effect.fn('github_accounts.fetch_viewer')(function* (
	token: Redacted.Redacted<string>,
) {
	const httpClient = yield* HttpClient.HttpClient
	const baseUrl = yield* Effect.orDie(githubApiBaseUrl)
	const request = HttpClientRequest.get(new URL('/user', baseUrl).toString()).pipe(
		HttpClientRequest.bearerToken(Redacted.value(token)),
		HttpClientRequest.setHeader('Accept', 'application/vnd.github+json'),
		HttpClientRequest.setHeader('X-GitHub-Api-Version', '2022-11-28'),
		HttpClientRequest.setHeader('User-Agent', 'devflow'),
	)
	const response = yield* httpClient
		.execute(request)
		.pipe(Effect.mapError(() => new GithubUnreachable({ reason: 'transport' })))
	if (response.status === 401) return yield* Effect.fail(new GithubTokenRejected({ status: response.status }))
	if (response.status < 200 || response.status >= 300)
		return yield* Effect.fail(new GithubUnreachable({ reason: 'status', status: response.status }))
	const body = yield* response.json.pipe(Effect.mapError(() => new GithubUnreachable({ reason: 'decode' })))
	const viewer = yield* Schema.decodeUnknownEffect(GithubViewerWire)(body).pipe(
		Effect.mapError(() => new GithubUnreachable({ reason: 'decode' })),
	)
	return { id: viewer.id, login: viewer.login, name: viewer.name } satisfies GithubViewer
})

const ownedBy = (actor: GithubAccountActor) =>
	and(eq(githubAccounts.organization_id, actor.organizationId), eq(githubAccounts.user_id, actor.userId))

const accountColumns = {
	id: githubAccounts.id,
	login: githubAccounts.login,
	name: githubAccounts.name,
	noreply_email: githubAccounts.noreply_email,
	status: githubAccounts.status,
	created_at: githubAccounts.created_at,
} as const

type AccountRow = Pick<GithubAccountRow, 'id' | 'login' | 'name' | 'noreply_email' | 'status' | 'created_at'>

/** The browser's view of an account: everything but the token. */
export const toGithubAccount = (row: AccountRow): GithubAccount => ({
	id: row.id,
	login: row.login,
	name: row.name,
	noreplyEmail: row.noreply_email,
	status: row.status,
	createdAt: Number(row.created_at),
})

/** The caller's accounts, oldest first, and which one is their default (null: the host's gh login). */
export const listGithubAccounts = Effect.fn('github_accounts.list')(function* (actor: GithubAccountActor) {
	const postgres = yield* PostgresDb
	const [rows, settings] = yield* Effect.all(
		[
			postgres.query(
				postgres.client
					.select(accountColumns)
					.from(githubAccounts)
					.where(ownedBy(actor))
					.orderBy(asc(githubAccounts.created_at), asc(githubAccounts.id)),
			),
			postgres.query(
				postgres.client
					.select({ defaultAccountId: userSettings.default_github_account_id })
					.from(userSettings)
					.where(
						and(
							eq(userSettings.organization_id, actor.organizationId),
							eq(userSettings.user_id, actor.userId),
						),
					),
			),
		],
		{ concurrency: 'unbounded' },
	)
	const accounts = rows.map(toGithubAccount)
	const defaultAccountId = settings[0]?.defaultAccountId ?? null
	return {
		accounts,
		// Only ever one of the caller's own (setDefault checks), but never point at anything else.
		defaultAccountId: accounts.some((account) => account.id === defaultAccountId) ? defaultAccountId : null,
	}
})

/**
 * Check a token with GitHub, then store it encrypted under the GitHub user it belongs to. Adding an
 * account the caller already has refreshes it: new token, current login and name, status `ok`.
 */
export const addGithubAccount = Effect.fn('github_accounts.add')(function* (input: {
	readonly actor: GithubAccountActor
	readonly token: Redacted.Redacted<string>
}) {
	const postgres = yield* PostgresDb
	const cipher = yield* TokenCipher
	const viewer = yield* fetchGithubViewer(input.token)
	const encrypted = yield* cipher.encrypt(input.token, tokenCipherContext(input.actor))
	const identity = { login: viewer.login, name: viewer.name, noreply_email: noreplyEmail(viewer) }
	const [row] = yield* postgres.query(
		postgres.client
			.insert(githubAccounts)
			.values({
				organization_id: input.actor.organizationId,
				user_id: input.actor.userId,
				github_user_id: viewer.id,
				...identity,
				token_iv: encrypted.iv,
				token_ciphertext: encrypted.ciphertext,
				status: 'ok',
			})
			.onConflictDoUpdate({
				target: [githubAccounts.organization_id, githubAccounts.user_id, githubAccounts.github_user_id],
				set: {
					...identity,
					token_iv: encrypted.iv,
					token_ciphertext: encrypted.ciphertext,
					status: 'ok',
					updated_at: sql`(extract(epoch from now()) * 1000)::bigint`,
				},
			})
			.returning(accountColumns),
	)
	if (row === undefined) return yield* Effect.die(new Error('Upserting a GitHub account returned no row'))
	return toGithubAccount(row)
})

/**
 * Give an account a new token. It must belong to the same GitHub user, so the account keeps its
 * place as a default everywhere; its login and name follow any rename, and its status returns to `ok`.
 */
export const replaceGithubAccountToken = Effect.fn('github_accounts.replace_token')(function* (input: {
	readonly actor: GithubAccountActor
	readonly accountId: string
	readonly token: Redacted.Redacted<string>
}) {
	const postgres = yield* PostgresDb
	const cipher = yield* TokenCipher
	const [existing] = yield* postgres.query(
		postgres.client
			.select({ githubUserId: githubAccounts.github_user_id, login: githubAccounts.login })
			.from(githubAccounts)
			.where(and(eq(githubAccounts.id, input.accountId), ownedBy(input.actor))),
	)
	if (existing === undefined) return yield* Effect.fail(new GithubAccountNotFound({ accountId: input.accountId }))
	const viewer = yield* fetchGithubViewer(input.token)
	if (viewer.id !== existing.githubUserId)
		return yield* Effect.fail(
			new GithubAccountMismatch({ expectedLogin: existing.login, actualLogin: viewer.login }),
		)
	const encrypted = yield* cipher.encrypt(input.token, tokenCipherContext(input.actor))
	const [row] = yield* postgres.query(
		postgres.client
			.update(githubAccounts)
			.set({
				login: viewer.login,
				name: viewer.name,
				noreply_email: noreplyEmail(viewer),
				token_iv: encrypted.iv,
				token_ciphertext: encrypted.ciphertext,
				status: 'ok',
			})
			.where(and(eq(githubAccounts.id, input.accountId), ownedBy(input.actor)))
			.returning(accountColumns),
	)
	// Removed while GitHub was being asked.
	if (row === undefined) return yield* Effect.fail(new GithubAccountNotFound({ accountId: input.accountId }))
	return toGithubAccount(row)
})

/** Delete an account and its token. Defaults that pointed at it fall through (the FKs set null). */
export const removeGithubAccount = Effect.fn('github_accounts.remove')(function* (input: {
	readonly actor: GithubAccountActor
	readonly accountId: string
}) {
	const postgres = yield* PostgresDb
	const removed = yield* postgres.query(
		postgres.client
			.delete(githubAccounts)
			.where(and(eq(githubAccounts.id, input.accountId), ownedBy(input.actor)))
			.returning({ id: githubAccounts.id }),
	)
	if (removed.length === 0) return yield* Effect.fail(new GithubAccountNotFound({ accountId: input.accountId }))
	return {}
})

/**
 * Make one of the caller's accounts their default, or null for the host's own gh login. The account
 * is share-locked while the default is written, so a concurrent remove can't leave it dangling.
 */
export const setDefaultGithubAccount = Effect.fn('github_accounts.set_default')(function* (input: {
	readonly actor: GithubAccountActor
	readonly accountId: string | null
}) {
	const postgres = yield* PostgresDb
	const { accountId, actor } = input
	yield* postgres.transaction((transaction) =>
		Effect.gen(function* () {
			if (accountId !== null) {
				const [account] = yield* transaction.query(
					transaction.client
						.select({ id: githubAccounts.id })
						.from(githubAccounts)
						.where(and(eq(githubAccounts.id, accountId), ownedBy(actor)))
						.for('share'),
				)
				if (account === undefined) return yield* Effect.fail(new GithubAccountNotFound({ accountId }))
			}
			yield* transaction.query(
				transaction.client
					.insert(userSettings)
					.values({
						user_id: actor.userId,
						organization_id: actor.organizationId,
						default_github_account_id: accountId,
					})
					.onConflictDoUpdate({
						target: [userSettings.user_id, userSettings.organization_id],
						set: {
							default_github_account_id: accountId,
							updated_at: sql`(extract(epoch from now()) * 1000)::bigint`,
						},
					}),
			)
		}),
	)
	return {}
})
