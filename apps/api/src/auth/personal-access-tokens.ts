import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { organizations } from '@devflow/db/tables/organizations'
import { eq } from 'drizzle-orm'
import { Context, Data, DateTime, Duration, Effect, Layer, Redacted } from 'effect'

import type { PostgresDbQueryError } from '../effects/services/postgres/postgres-db.errors'
import { PostgresDb } from '../effects/services/postgres/postgres-db.service'
import { requireEnvironment } from '../lib/environment'
import type { AuthContext } from './jwt-validator'

export type PersonalAccessTokenExpiryDays = 7 | 14 | 30 | 60 | 90

export type PersonalAccessToken = {
	id: string
	name: string
	obfuscatedValue: string
	createdAt: string
	expiresAt: string | null
	lastUsedAt: string | null
}

/** A stored token. Only the SHA-256 of the secret value is kept. */
export type StoredPersonalAccessToken = PersonalAccessToken & {
	userId: string
	/** External organization id (`organizations.workos_organization_id`). */
	organizationId: string
	valueHash: string
}

type PersonalAccessTokenCreation = {
	readonly token: PersonalAccessToken
	readonly value: Redacted.Redacted<string>
}

export class PersonalAccessTokenNotFoundError extends Data.TaggedError('PersonalAccessTokenNotFoundError')<{
	id: string
}> {}

export class PersonalAccessTokenStoreError extends Data.TaggedError('PersonalAccessTokenStoreError')<{
	cause: unknown
}> {}

/** Persistence for personal access tokens. */
export class PersonalAccessTokenStore extends Context.Service<
	PersonalAccessTokenStore,
	{
		readonly list: () => Effect.Effect<ReadonlyArray<StoredPersonalAccessToken>, PersonalAccessTokenStoreError>
		readonly insert: (token: StoredPersonalAccessToken) => Effect.Effect<void, PersonalAccessTokenStoreError>
		readonly remove: (id: string) => Effect.Effect<void, PersonalAccessTokenStoreError>
		readonly touch: (id: string, lastUsedAt: string) => Effect.Effect<void, PersonalAccessTokenStoreError>
	}
>()('PersonalAccessTokenStore') {}

/** Store over a mutable array; the file-backed store and tests share it. */
const makeStore = (
	load: () => Promise<StoredPersonalAccessToken[]>,
	save: (tokens: StoredPersonalAccessToken[]) => Promise<void>,
): typeof PersonalAccessTokenStore.Service => {
	const attempt = <A>(run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: (cause) => new PersonalAccessTokenStoreError({ cause }) })
	// Serialize read-modify-write cycles so concurrent requests cannot drop each other's writes.
	let queue: Promise<unknown> = Promise.resolve()
	const update = (change: (tokens: StoredPersonalAccessToken[]) => StoredPersonalAccessToken[]) =>
		attempt(() => {
			const next = queue.then(async () => save(change(await load())))
			queue = next.catch(() => undefined)
			return next
		})
	return {
		list: () => attempt(load),
		insert: (token) => update((tokens) => [...tokens, token]),
		remove: (id) => update((tokens) => tokens.filter((token) => token.id !== id)),
		touch: (id, lastUsedAt) =>
			update((tokens) => tokens.map((token) => (token.id === id ? { ...token, lastUsedAt } : token))),
	}
}

export const makeInMemoryPersonalAccessTokenStore = (initial: StoredPersonalAccessToken[] = []) => {
	let tokens = [...initial]
	return makeStore(
		async () => tokens,
		async (next) => {
			tokens = next
		},
	)
}

/**
 * JSON file next to the auth signing key (DEVFLOW_AUTH_PRIVATE_JWK_PATH), or DEVFLOW_PAT_STORE_PATH.
 * Writes go to a temp file first and are renamed into place.
 */
export const PersonalAccessTokenFileStoreLive = Layer.sync(PersonalAccessTokenStore, () => {
	const storePath = () =>
		process.env.DEVFLOW_PAT_STORE_PATH ??
		join(dirname(requireEnvironment('DEVFLOW_AUTH_PRIVATE_JWK_PATH')), 'personal-access-tokens.json')
	return makeStore(
		async () => {
			try {
				return JSON.parse(await readFile(storePath(), 'utf8')) as StoredPersonalAccessToken[]
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
				throw error
			}
		},
		async (tokens) => {
			const path = storePath()
			await mkdir(dirname(path), { recursive: true })
			const tempPath = `${path}.${randomUUID()}.tmp`
			await writeFile(tempPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
			await rename(tempPath, path)
		},
	)
})

const TOKEN_PREFIX = 'dfpat_'

const hashTokenValue = (value: string) => createHash('sha256').update(value).digest('hex')

const projectPersonalAccessToken = (token: StoredPersonalAccessToken): PersonalAccessToken => ({
	id: token.id,
	name: token.name,
	obfuscatedValue: token.obfuscatedValue,
	createdAt: token.createdAt,
	expiresAt: token.expiresAt,
	lastUsedAt: token.lastUsedAt,
})

const isExpired = (token: StoredPersonalAccessToken, now: number) =>
	token.expiresAt !== null && Date.parse(token.expiresAt) <= now

const ownedBy = (input: { userId: string; workosOrganizationId: string }) => (token: StoredPersonalAccessToken) =>
	token.userId === input.userId && token.organizationId === input.workosOrganizationId

export const createPersonalAccessToken = Effect.fn('auth.create_personal_access_token')(
	(input: {
		userId: string
		workosOrganizationId: string
		name: string
		expiresInDays: PersonalAccessTokenExpiryDays
	}): Effect.Effect<PersonalAccessTokenCreation, PersonalAccessTokenStoreError, PersonalAccessTokenStore> =>
		Effect.gen(function* () {
			const store = yield* PersonalAccessTokenStore
			const value = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
			const now = yield* DateTime.now
			const stored: StoredPersonalAccessToken = {
				id: `pat_${randomUUID()}`,
				name: input.name,
				obfuscatedValue: `${TOKEN_PREFIX}...${value.slice(-4)}`,
				createdAt: DateTime.formatIso(now),
				expiresAt: DateTime.formatIso(DateTime.addDuration(now, Duration.days(input.expiresInDays))),
				lastUsedAt: null,
				userId: input.userId,
				organizationId: input.workosOrganizationId,
				valueHash: hashTokenValue(value),
			}
			yield* store.insert(stored)
			return { token: projectPersonalAccessToken(stored), value: Redacted.make(value) }
		}),
)

export const listPersonalAccessTokens = Effect.fn('auth.list_personal_access_tokens')(
	(input: {
		userId: string
		workosOrganizationId: string
	}): Effect.Effect<ReadonlyArray<PersonalAccessToken>, PersonalAccessTokenStoreError, PersonalAccessTokenStore> =>
		Effect.gen(function* () {
			const store = yield* PersonalAccessTokenStore
			const tokens = yield* store.list()
			return tokens.filter(ownedBy(input)).map(projectPersonalAccessToken)
		}),
)

export const revokePersonalAccessToken = Effect.fn('auth.revoke_personal_access_token')(
	(input: {
		userId: string
		workosOrganizationId: string
		id: string
	}): Effect.Effect<
		void,
		PersonalAccessTokenStoreError | PersonalAccessTokenNotFoundError,
		PersonalAccessTokenStore
	> =>
		Effect.gen(function* () {
			const store = yield* PersonalAccessTokenStore
			const tokens = yield* store.list()
			if (!tokens.filter(ownedBy(input)).some((token) => token.id === input.id)) {
				return yield* new PersonalAccessTokenNotFoundError({ id: input.id })
			}
			yield* store.remove(input.id)
		}),
)

export const authenticatePersonalAccessToken = Effect.fn('auth.authenticate_personal_access_token')(
	(input: {
		value: string
	}): Effect.Effect<
		AuthContext | null,
		PersonalAccessTokenStoreError | PostgresDbQueryError,
		PersonalAccessTokenStore | PostgresDb
	> =>
		Effect.gen(function* () {
			if (!input.value.startsWith(TOKEN_PREFIX)) return null
			const store = yield* PersonalAccessTokenStore
			const valueHash = hashTokenValue(input.value)
			const now = yield* DateTime.now
			const token = (yield* store.list()).find((candidate) => candidate.valueHash === valueHash)
			if (!token || isExpired(token, DateTime.toEpochMillis(now))) return null

			const postgres = yield* PostgresDb
			const [organization] = yield* postgres.query(
				postgres.client
					.select({ id: organizations.id })
					.from(organizations)
					.where(eq(organizations.workos_organization_id, token.organizationId))
					.limit(1),
			)
			if (!organization) return null

			// Record use at most once a minute to avoid a file write per request.
			if (token.lastUsedAt === null || DateTime.toEpochMillis(now) - Date.parse(token.lastUsedAt) > 60_000) {
				yield* store.touch(token.id, DateTime.formatIso(now))
			}

			return {
				userId: token.userId,
				organizationId: organization.id,
				workosOrganizationId: token.organizationId,
				role: 'member',
				roles: ['member'],
				permissions: [],
				entitlements: [],
			}
		}),
)
