import { randomUUID } from 'node:crypto'

import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { organizations } from '@devflow/db/tables/organizations'
import { userSettings } from '@devflow/db/tables/user-settings'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer, Redacted } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type { HttpClientRequest } from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { tokenCipherContext } from '../../src/effects/github-accounts/github-accounts'
import { makeTokenCipher, TokenCipher, TokenStorageUnavailable } from '../../src/effects/github-accounts/token-cipher'
import { addGithubAccountProcedure } from '../../src/orpc/api/github-accounts/add.effect'
import { listGithubAccountsProcedure } from '../../src/orpc/api/github-accounts/list.effect'
import { removeGithubAccountProcedure } from '../../src/orpc/api/github-accounts/remove.effect'
import { replaceGithubAccountTokenProcedure } from '../../src/orpc/api/github-accounts/replace-token.effect'
import { setDefaultGithubAccountProcedure } from '../../src/orpc/api/github-accounts/set-default.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import {
	bindProcedureToRuntime,
	createRuntimeWithTestPostgresLayer,
	TEST_GITHUB_ACCOUNT_TOKEN_KEY,
} from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/** Personal access tokens the stubbed GitHub knows, and who each belongs to. */
const WORK_TOKEN = 'github_pat_work_0000000000000000000000000000000000'
const WORK_TOKEN_ROTATED = 'github_pat_work_1111111111111111111111111111111111'
const PERSONAL_TOKEN = 'ghp_personal000000000000000000000000000000'
const TEAMMATE_TOKEN = 'ghp_teammate000000000000000000000000000000'
const REVOKED_TOKEN = 'ghp_revoked0000000000000000000000000000000'
const FLAKY_TOKEN = 'ghp_flaky000000000000000000000000000000000'
const ALL_TOKENS = [WORK_TOKEN, WORK_TOKEN_ROTATED, PERSONAL_TOKEN, TEAMMATE_TOKEN, REVOKED_TOKEN, FLAKY_TOKEN]

const viewers: Record<string, { id: number; login: string; name: string | null }> = {
	[WORK_TOKEN]: { id: 1001, login: 'stan-work', name: 'Stan' },
	[WORK_TOKEN_ROTATED]: { id: 1001, login: 'stan-work-renamed', name: 'Stan W' },
	[PERSONAL_TOKEN]: { id: 1002, login: 'stan-personal', name: null },
	[TEAMMATE_TOKEN]: { id: 2001, login: 'ada', name: 'Ada' },
}

const jsonResponse = (request: HttpClientRequest, body: unknown, status = 200) =>
	HttpClientResponse.fromWeb(
		request,
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
	)

describe('githubAccounts', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let keylessRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let organizationId: string
	/** Every `GET /user` the stubbed GitHub received, by the token it carried. */
	let githubRequests: string[] = []

	const transport = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) =>
			Effect.sync(() => {
				const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
				githubRequests.push(token)
				if (request.method !== 'GET' || url.pathname !== '/user')
					return jsonResponse(request, { message: 'Not Found' }, 404)
				if (token === FLAKY_TOKEN) return jsonResponse(request, { message: 'Server Error' }, 502)
				const viewer = viewers[token]
				if (!viewer) return jsonResponse(request, { message: 'Bad credentials' }, 401)
				return jsonResponse(request, { ...viewer, email: null, type: 'User', site_admin: false })
			}),
		),
	)

	const procedures = (bound: ReturnType<typeof createRuntimeWithTestPostgresLayer>) => ({
		list: bindProcedureToRuntime(listGithubAccountsProcedure, bound),
		add: bindProcedureToRuntime(addGithubAccountProcedure, bound),
		replaceToken: bindProcedureToRuntime(replaceGithubAccountTokenProcedure, bound),
		remove: bindProcedureToRuntime(removeGithubAccountProcedure, bound),
		setDefault: bindProcedureToRuntime(setDefaultGithubAccountProcedure, bound),
	})
	let api: ReturnType<typeof procedures>

	beforeAll(async () => {
		const testDb = await createTestDb('github_accounts')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db, { httpClient: transport })
		keylessRuntime = createRuntimeWithTestPostgresLayer(db, {
			httpClient: transport,
			tokenCipher: Layer.succeed(
				TokenCipher,
				makeTokenCipher(new TokenStorageUnavailable({ reason: 'missing' })),
			),
		})
		api = procedures(runtime)
		const [organization] = await db
			.insert(organizations)
			.values({ name: 'GitHub accounts', workos_organization_id: `org_${randomUUID()}` })
			.returning()
		if (!organization) throw new Error('Could not seed the organization')
		organizationId = organization.id
	}, 60_000)

	afterAll(async () => {
		try {
			await runtime?.dispose()
			await keylessRuntime?.dispose()
		} finally {
			await cleanup?.()
		}
	}, 30_000)

	beforeEach(() => {
		githubRequests = []
	})

	/** A fresh user per test, so no test sees another's accounts. */
	const newUser = () => `user_${randomUUID()}`

	const asUser = (userId: string, bound = runtime) => ({
		context: createMockApiContext({
			auth: createMockApiAuth({ organizationId, userId }),
			services: { db, dbReadReplica: db, effectRuntime: bound },
		}),
	})

	const storedRows = (userId: string) =>
		db
			.select()
			.from(githubAccounts)
			.where(and(eq(githubAccounts.organization_id, organizationId), eq(githubAccounts.user_id, userId)))

	const storedDefault = async (userId: string) => {
		const [row] = await db
			.select({ id: userSettings.default_github_account_id })
			.from(userSettings)
			.where(and(eq(userSettings.organization_id, organizationId), eq(userSettings.user_id, userId)))
		return row?.id ?? null
	}

	const decryptStored = (userId: string, row: { token_iv: Uint8Array; token_ciphertext: Uint8Array }) =>
		Effect.runPromise(
			makeTokenCipher(TEST_GITHUB_ACCOUNT_TOKEN_KEY).decrypt(
				{ iv: row.token_iv, ciphertext: row.token_ciphertext },
				tokenCipherContext({ organizationId, userId }),
			),
		).then(Redacted.value)

	const expectNoToken = (response: unknown) => {
		const body = JSON.stringify(response)
		for (const token of ALL_TOKENS) expect(body).not.toContain(token)
	}

	it('adds an account under the login GitHub reports, and stores only an encrypted token', async () => {
		const me = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))

		expect(account).toEqual({
			id: expect.any(String),
			login: 'stan-work',
			name: 'Stan',
			noreplyEmail: '1001+stan-work@users.noreply.github.com',
			status: 'ok',
			createdAt: expect.any(Number),
		})
		expect(githubRequests).toEqual([WORK_TOKEN])

		const [row] = await storedRows(me)
		expect(row).toMatchObject({ github_user_id: 1001, login: 'stan-work', status: 'ok' })
		if (!row) throw new Error('The account was not stored')
		expect(Buffer.from(row.token_ciphertext).includes(Buffer.from(WORK_TOKEN))).toBe(false)
		expect(await decryptStored(me, row)).toBe(WORK_TOKEN)
	})

	it('trims a pasted token before checking it', async () => {
		const me = newUser()
		await call(api.add, { token: `  ${PERSONAL_TOKEN}\n` }, asUser(me))
		expect(githubRequests).toEqual([PERSONAL_TOKEN])
		const [row] = await storedRows(me)
		if (!row) throw new Error('The account was not stored')
		expect(await decryptStored(me, row)).toBe(PERSONAL_TOKEN)
	})

	it('refuses a token GitHub rejects, and stores nothing', async () => {
		const me = newUser()
		await expect(call(api.add, { token: REVOKED_TOKEN }, asUser(me))).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			data: { message: expect.stringContaining('GitHub rejected this token') },
		})
		expect(await storedRows(me)).toHaveLength(0)
	})

	it('reports GitHub being unreachable apart from a rejected token', async () => {
		const me = newUser()
		await expect(call(api.add, { token: FLAKY_TOKEN }, asUser(me))).rejects.toMatchObject({
			code: 'GITHUB_UNREACHABLE',
		})
		expect(await storedRows(me)).toHaveLength(0)
	})

	it('refreshes an account that is added again instead of duplicating it', async () => {
		const me = newUser()
		const first = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		await db.update(githubAccounts).set({ status: 'needs_token' }).where(eq(githubAccounts.id, first.account.id))

		const second = await call(api.add, { token: WORK_TOKEN_ROTATED }, asUser(me))

		expect(second.account).toMatchObject({ id: first.account.id, login: 'stan-work-renamed', status: 'ok' })
		const rows = await storedRows(me)
		expect(rows).toHaveLength(1)
		const [row] = rows
		if (!row) throw new Error('The account was not stored')
		expect(await decryptStored(me, row)).toBe(WORK_TOKEN_ROTATED)
	})

	it('fails with TOKEN_STORAGE_UNAVAILABLE when the server has no key, and stores nothing', async () => {
		const me = newUser()
		const keyless = procedures(keylessRuntime)
		await expect(call(keyless.add, { token: WORK_TOKEN }, asUser(me, keylessRuntime))).rejects.toMatchObject({
			code: 'TOKEN_STORAGE_UNAVAILABLE',
			data: { message: expect.stringContaining('GITHUB_ACCOUNT_TOKEN_KEY') },
		})
		expect(await storedRows(me)).toHaveLength(0)
		// Listing needs no key.
		await expect(call(keyless.list, {}, asUser(me, keylessRuntime))).resolves.toEqual({
			accounts: [],
			defaultAccountId: null,
			projectDefaults: {},
		})
	})

	it('lists only the caller’s own accounts, oldest first', async () => {
		const me = newUser()
		const teammate = newUser()
		const work = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		const personal = await call(api.add, { token: PERSONAL_TOKEN }, asUser(me))
		await call(api.add, { token: TEAMMATE_TOKEN }, asUser(teammate))

		const mine = await call(api.list, {}, asUser(me))
		expect(mine.accounts.map((account) => account.login)).toEqual(['stan-work', 'stan-personal'])
		expect(mine.accounts.map((account) => account.id)).toEqual([work.account.id, personal.account.id])
		expect(mine.defaultAccountId).toBeNull()

		const theirs = await call(api.list, {}, asUser(teammate))
		expect(theirs.accounts.map((account) => account.login)).toEqual(['ada'])
	})

	it('sets and clears the default, and only to the caller’s own account', async () => {
		const me = newUser()
		const teammate = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		const { account: theirs } = await call(api.add, { token: TEAMMATE_TOKEN }, asUser(teammate))

		await expect(call(api.setDefault, { accountId: account.id }, asUser(me))).resolves.toEqual({})
		expect((await call(api.list, {}, asUser(me))).defaultAccountId).toBe(account.id)
		expect(await storedDefault(me)).toBe(account.id)

		await expect(call(api.setDefault, { accountId: theirs.id }, asUser(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		expect(await storedDefault(me)).toBe(account.id)

		await call(api.setDefault, { accountId: null }, asUser(me))
		expect((await call(api.list, {}, asUser(me))).defaultAccountId).toBeNull()
		expect(await storedDefault(me)).toBeNull()
	})

	it('replaces a token for the same GitHub user, keeping the account and its default', async () => {
		const me = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		await call(api.setDefault, { accountId: account.id }, asUser(me))
		await db.update(githubAccounts).set({ status: 'needs_token' }).where(eq(githubAccounts.id, account.id))

		const replaced = await call(api.replaceToken, { accountId: account.id, token: WORK_TOKEN_ROTATED }, asUser(me))

		expect(replaced.account).toMatchObject({ id: account.id, login: 'stan-work-renamed', status: 'ok' })
		const [row] = await storedRows(me)
		if (!row) throw new Error('The account was not stored')
		expect(await decryptStored(me, row)).toBe(WORK_TOKEN_ROTATED)
		expect(await storedDefault(me)).toBe(account.id)
	})

	it('refuses a replacement token for a different GitHub user, and keeps the old one', async () => {
		const me = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))

		await expect(
			call(api.replaceToken, { accountId: account.id, token: PERSONAL_TOKEN }, asUser(me)),
		).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			data: { message: expect.stringContaining('belongs to stan-personal, not stan-work') },
		})
		const [row] = await storedRows(me)
		if (!row) throw new Error('The account was not stored')
		expect(await decryptStored(me, row)).toBe(WORK_TOKEN)
	})

	it('refuses a rejected replacement token', async () => {
		const me = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		await expect(
			call(api.replaceToken, { accountId: account.id, token: REVOKED_TOKEN }, asUser(me)),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
	})

	it('keeps each user’s accounts out of everyone else’s reach', async () => {
		const me = newUser()
		const teammate = newUser()
		const { account: theirs } = await call(api.add, { token: TEAMMATE_TOKEN }, asUser(teammate))
		githubRequests = []

		await expect(
			call(api.replaceToken, { accountId: theirs.id, token: WORK_TOKEN }, asUser(me)),
		).rejects.toMatchObject({ code: 'NOT_FOUND' })
		// Refused before GitHub is asked about the token.
		expect(githubRequests).toEqual([])
		await expect(call(api.remove, { accountId: theirs.id }, asUser(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		expect(await storedRows(teammate)).toHaveLength(1)
	})

	it('removes an account and its token, and a default on it falls back to the host login', async () => {
		const me = newUser()
		const { account } = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		await call(api.setDefault, { accountId: account.id }, asUser(me))

		await expect(call(api.remove, { accountId: account.id }, asUser(me))).resolves.toEqual({})

		expect(await storedRows(me)).toHaveLength(0)
		expect(await storedDefault(me)).toBeNull()
		expect(await call(api.list, {}, asUser(me))).toEqual({
			accounts: [],
			defaultAccountId: null,
			projectDefaults: {},
		})
		await expect(call(api.remove, { accountId: account.id }, asUser(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})

	it('never returns a token from any procedure', async () => {
		const me = newUser()
		const added = await call(api.add, { token: WORK_TOKEN }, asUser(me))
		const listed = await call(api.list, {}, asUser(me))
		const replaced = await call(
			api.replaceToken,
			{ accountId: added.account.id, token: WORK_TOKEN_ROTATED },
			asUser(me),
		)
		const defaulted = await call(api.setDefault, { accountId: added.account.id }, asUser(me))
		const removed = await call(api.remove, { accountId: added.account.id }, asUser(me))
		const rejected = await call(api.add, { token: REVOKED_TOKEN }, asUser(me)).catch((error: unknown) => error)

		for (const response of [added, listed, replaced, defaulted, removed, rejected]) expectNoToken(response)
	})
})
