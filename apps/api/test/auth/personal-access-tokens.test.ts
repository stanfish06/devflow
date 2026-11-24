import { organizations } from '@devflow/db/tables/organizations'
import { Effect, Layer, Redacted } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
	authenticatePersonalAccessToken,
	createPersonalAccessToken,
	listPersonalAccessTokens,
	makeInMemoryPersonalAccessTokenStore,
	PersonalAccessTokenNotFoundError,
	PersonalAccessTokenStore,
	revokePersonalAccessToken,
	type StoredPersonalAccessToken,
} from '../../src/auth/personal-access-tokens'
import { type PostgresDb, PostgresDbLive } from '../../src/effects/services/postgres/postgres-db.service'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('personal access tokens', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db']
	let cleanup: (() => Promise<void>) | undefined

	beforeAll(async () => {
		const testDb = await createTestDb('personal_access_tokens')
		db = testDb.db
		cleanup = testDb.cleanup
		await db.insert(organizations).values({
			name: 'PAT test organization',
			workos_organization_id: 'workos_org_1',
		})
	}, 60_000)

	afterAll(async () => {
		await cleanup?.()
	}, 30_000)

	const run = <A, E>(
		effect: Effect.Effect<A, E, PersonalAccessTokenStore | PostgresDb>,
		store = makeInMemoryPersonalAccessTokenStore(),
	) =>
		Effect.runPromise(
			effect.pipe(
				Effect.provide(Layer.mergeAll(Layer.succeed(PersonalAccessTokenStore, store), PostgresDbLive(db))),
			),
		)

	const owner = { userId: 'user_1', workosOrganizationId: 'workos_org_1' }

	test('creates a token with the selected expiry and stores only its hash', async () => {
		const stored: StoredPersonalAccessToken[] = []
		const store = makeInMemoryPersonalAccessTokenStore(stored)
		const before = Date.now()
		const created = await run(createPersonalAccessToken({ ...owner, name: 'Actions', expiresInDays: 30 }), store)

		const value = Redacted.value(created.value)
		expect(value.startsWith('dfpat_')).toBe(true)
		expect(created.token.name).toBe('Actions')
		expect(created.token.obfuscatedValue.endsWith(value.slice(-4))).toBe(true)
		const expiresAt = Date.parse(created.token.expiresAt ?? '')
		expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000)
		const [row] = await Effect.runPromise(store.list())
		expect(JSON.stringify(row)).not.toContain(value)
	})

	test('lists and revokes only tokens owned by the selected user and organization', async () => {
		const store = makeInMemoryPersonalAccessTokenStore()
		const mine = await run(createPersonalAccessToken({ ...owner, name: 'Mine', expiresInDays: 7 }), store)
		const other = await run(
			createPersonalAccessToken({
				userId: 'user_2',
				workosOrganizationId: 'workos_org_1',
				name: 'Theirs',
				expiresInDays: 7,
			}),
			store,
		)

		const listed = await run(listPersonalAccessTokens(owner), store)
		expect(listed.map((token) => token.id)).toEqual([mine.token.id])

		const error = await run(revokePersonalAccessToken({ ...owner, id: other.token.id }).pipe(Effect.flip), store)
		expect(error).toBeInstanceOf(PersonalAccessTokenNotFoundError)

		await run(revokePersonalAccessToken({ ...owner, id: mine.token.id }), store)
		expect(await run(listPersonalAccessTokens(owner), store)).toEqual([])
	})

	test('maps a token to the internal organization as a non-admin context', async () => {
		const store = makeInMemoryPersonalAccessTokenStore()
		const created = await run(createPersonalAccessToken({ ...owner, name: 'Actions', expiresInDays: 7 }), store)

		const auth = await run(authenticatePersonalAccessToken({ value: Redacted.value(created.value) }), store)

		expect(auth).toMatchObject({
			userId: 'user_1',
			workosOrganizationId: 'workos_org_1',
			role: 'member',
			roles: ['member'],
		})
		expect(auth?.organizationId).toBeTypeOf('string')
	})

	test('rejects unknown, expired, and unmapped tokens', async () => {
		const store = makeInMemoryPersonalAccessTokenStore()
		expect(await run(authenticatePersonalAccessToken({ value: 'dfpat_unknown' }), store)).toBeNull()
		expect(await run(authenticatePersonalAccessToken({ value: 'not-a-pat' }), store)).toBeNull()

		const unmapped = await run(
			createPersonalAccessToken({
				userId: 'user_1',
				workosOrganizationId: 'workos_missing',
				name: 'x',
				expiresInDays: 7,
			}),
			store,
		)
		expect(await run(authenticatePersonalAccessToken({ value: Redacted.value(unmapped.value) }), store)).toBeNull()

		const expiring = await run(createPersonalAccessToken({ ...owner, name: 'old', expiresInDays: 7 }), store)
		const rows = await Effect.runPromise(store.list())
		await Effect.runPromise(store.remove(expiring.token.id))
		const expired = rows.find((row) => row.id === expiring.token.id)
		if (!expired) throw new Error('Expected the stored token')
		await Effect.runPromise(store.insert({ ...expired, expiresAt: new Date(Date.now() - 1000).toISOString() }))
		expect(await run(authenticatePersonalAccessToken({ value: Redacted.value(expiring.value) }), store)).toBeNull()
	})
})
