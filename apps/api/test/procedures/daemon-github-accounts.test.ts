import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { organizations } from '@devflow/db/tables/organizations'
import { sessions } from '@devflow/db/tables/sessions'
import { userSettings } from '@devflow/db/tables/user-settings'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer, Redacted } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { tokenCipherContext } from '../../src/effects/github-accounts/github-accounts'
import { makeTokenCipher, TokenCipher, TokenStorageUnavailable } from '../../src/effects/github-accounts/token-cipher'
import { resolveGithubTokenProcedure } from '../../src/orpc/daemon/github-accounts/resolve-token.effect'
import { createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import {
	bindProcedureToRuntime,
	createRuntimeWithTestPostgresLayer,
	TEST_GITHUB_ACCOUNT_TOKEN_KEY,
} from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const WORK_TOKEN = 'github_pat_work_0000000000000000000000000000000000'
const TEAMMATE_TOKEN = 'ghp_teammate000000000000000000000000000000'

describe('daemon githubAccounts.resolveToken', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let keylessRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let resolveToken: typeof resolveGithubTokenProcedure
	let resolveTokenWithoutKey: typeof resolveGithubTokenProcedure
	let organizationId: string
	let otherOrganizationId: string

	beforeAll(async () => {
		const testDb = await createTestDb('daemon_github_accounts')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db)
		keylessRuntime = createRuntimeWithTestPostgresLayer(db, {
			tokenCipher: Layer.succeed(
				TokenCipher,
				makeTokenCipher(new TokenStorageUnavailable({ reason: 'missing' })),
			),
		})
		resolveToken = bindProcedureToRuntime(resolveGithubTokenProcedure, runtime)
		resolveTokenWithoutKey = bindProcedureToRuntime(resolveGithubTokenProcedure, keylessRuntime)
		const [organization, otherOrganization] = await db
			.insert(organizations)
			.values([
				{ name: 'Daemon GitHub accounts', workos_organization_id: `org_${randomUUID()}` },
				{ name: 'Other daemon GitHub accounts', workos_organization_id: `org_${randomUUID()}` },
			])
			.returning()
		if (!organization || !otherOrganization) throw new Error('Could not seed the organizations')
		organizationId = organization.id
		otherOrganizationId = otherOrganization.id
	}, 60_000)

	afterAll(async () => {
		try {
			await runtime?.dispose()
			await keylessRuntime?.dispose()
		} finally {
			await cleanup?.()
		}
	}, 30_000)

	/** A fresh user and host per test, so no test sees another's sessions or accounts. */
	const newDaemon = () => ({ userId: `user_${randomUUID()}`, hostId: randomUUID(), organizationId })

	const asDaemon = (daemon: { userId: string; hostId: string; organizationId: string }) => ({
		context: createMockDaemonContext({
			auth: createMockDaemonAuth(daemon),
			services: { db, dbReadReplica: db },
		}),
	})

	const createSession = async (owner: { userId: string; hostId: string; organizationId: string }) => {
		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: owner.organizationId,
				resource_owner_user_id: owner.userId,
				created_by: owner.userId,
				host_id: owner.hostId,
				title: 'GitHub account session',
				working_directory: tmpdir(),
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissions_mode: 'default',
				status: 'running',
			})
			.returning({ id: sessions.id })
		if (!session) throw new Error('Could not seed the session')
		return session.id
	}

	/** Store an account with its token encrypted the way githubAccounts.add does. */
	const createAccount = async (
		owner: { userId: string; organizationId: string },
		account: { githubUserId: number; login: string; name: string | null; token: string },
	) => {
		const encrypted = await Effect.runPromise(
			makeTokenCipher(TEST_GITHUB_ACCOUNT_TOKEN_KEY).encrypt(
				Redacted.make(account.token),
				tokenCipherContext({ organizationId: owner.organizationId, userId: owner.userId }),
			),
		)
		const [row] = await db
			.insert(githubAccounts)
			.values({
				organization_id: owner.organizationId,
				user_id: owner.userId,
				github_user_id: account.githubUserId,
				login: account.login,
				name: account.name,
				noreply_email: `${account.githubUserId}+${account.login}@users.noreply.github.com`,
				token_iv: encrypted.iv,
				token_ciphertext: encrypted.ciphertext,
				status: 'ok',
			})
			.returning({ id: githubAccounts.id })
		if (!row) throw new Error('Could not seed the account')
		return row.id
	}

	const setDefault = (owner: { userId: string; organizationId: string }, accountId: string | null) =>
		db
			.insert(userSettings)
			.values({
				user_id: owner.userId,
				organization_id: owner.organizationId,
				default_github_account_id: accountId,
			})
			.onConflictDoUpdate({
				target: [userSettings.user_id, userSettings.organization_id],
				set: { default_github_account_id: accountId },
			})

	it("keeps the host's own gh login when the user has no default account", async () => {
		const me = newDaemon()
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).resolves.toEqual({ useHostLogin: true })
	})

	it("keeps the host's own gh login when the default is explicitly the host login", async () => {
		const me = newDaemon()
		await createAccount(me, { githubUserId: 1001, login: 'stan-work', name: 'Stan', token: WORK_TOKEN })
		await setDefault(me, null)
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).resolves.toEqual({ useHostLogin: true })
	})

	it("returns the default account's identity and decrypted token for the daemon's own session", async () => {
		const me = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		await setDefault(me, accountId)
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).resolves.toEqual({
			accountId,
			login: 'stan-work',
			name: 'Stan',
			email: '1001+stan-work@users.noreply.github.com',
			token: WORK_TOKEN,
		})
	})

	it('still returns an account whose token GitHub has rejected, rather than falling back', async () => {
		const me = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: null,
			token: WORK_TOKEN,
		})
		await db.update(githubAccounts).set({ status: 'needs_token' }).where(eq(githubAccounts.id, accountId))
		await setDefault(me, accountId)
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).resolves.toMatchObject({
			accountId,
			login: 'stan-work',
			name: null,
		})
	})

	it("refuses another user's session with NOT_FOUND, even on the same host", async () => {
		const me = newDaemon()
		const teammate = { ...newDaemon(), hostId: me.hostId }
		const teammateAccountId = await createAccount(teammate, {
			githubUserId: 2001,
			login: 'ada',
			name: 'Ada',
			token: TEAMMATE_TOKEN,
		})
		await setDefault(teammate, teammateAccountId)
		const teammateSessionId = await createSession(teammate)

		const attempt = call(resolveToken, { sessionId: teammateSessionId }, asDaemon(me))
		await expect(attempt).rejects.toMatchObject({ code: 'NOT_FOUND' })
		await expect(attempt.catch((error: unknown) => JSON.stringify(error))).resolves.not.toContain(TEAMMATE_TOKEN)
	})

	it("refuses the user's own session on another of their hosts", async () => {
		const me = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		await setDefault(me, accountId)
		const sessionOnOtherHost = await createSession({ ...me, hostId: randomUUID() })

		await expect(call(resolveToken, { sessionId: sessionOnOtherHost }, asDaemon(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})

	it("refuses a session from another organization, and never reads that organization's default", async () => {
		const me = newDaemon()
		const elsewhere = { ...me, organizationId: otherOrganizationId }
		const accountId = await createAccount(elsewhere, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		await setDefault(elsewhere, accountId)
		const sessionElsewhere = await createSession(elsewhere)
		const sessionHere = await createSession(me)

		await expect(call(resolveToken, { sessionId: sessionElsewhere }, asDaemon(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		await expect(call(resolveToken, { sessionId: sessionHere }, asDaemon(me))).resolves.toEqual({
			useHostLogin: true,
		})
	})

	it('refuses a session that does not exist', async () => {
		const me = newDaemon()
		await expect(call(resolveToken, { sessionId: randomUUID() }, asDaemon(me))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})

	it("falls back to the host's login once the default account is removed", async () => {
		const me = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		await setDefault(me, accountId)
		await db.delete(githubAccounts).where(eq(githubAccounts.id, accountId))
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).resolves.toEqual({ useHostLogin: true })
	})

	it('reports SERVICE_UNAVAILABLE, not the host login, when the server cannot decrypt tokens', async () => {
		const me = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		await setDefault(me, accountId)
		const sessionId = await createSession(me)

		await expect(call(resolveTokenWithoutKey, { sessionId }, asDaemon(me))).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		})
	})

	it('reports INTERNAL_SERVER_ERROR when a stored token does not open for its owner', async () => {
		const me = newDaemon()
		const teammate = newDaemon()
		const accountId = await createAccount(me, {
			githubUserId: 1001,
			login: 'stan-work',
			name: 'Stan',
			token: WORK_TOKEN,
		})
		// A ciphertext copied from another user's row is bound to that user, so it must not open here.
		const encryptedForTeammate = await Effect.runPromise(
			makeTokenCipher(TEST_GITHUB_ACCOUNT_TOKEN_KEY).encrypt(
				Redacted.make(TEAMMATE_TOKEN),
				tokenCipherContext({ organizationId, userId: teammate.userId }),
			),
		)
		await db
			.update(githubAccounts)
			.set({ token_iv: encryptedForTeammate.iv, token_ciphertext: encryptedForTeammate.ciphertext })
			.where(eq(githubAccounts.id, accountId))
		await setDefault(me, accountId)
		const sessionId = await createSession(me)

		await expect(call(resolveToken, { sessionId }, asDaemon(me))).rejects.toMatchObject({
			code: 'INTERNAL_SERVER_ERROR',
		})
	})
})
