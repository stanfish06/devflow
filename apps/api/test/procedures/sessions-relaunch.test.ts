import { tmpdir } from 'node:os'

import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { organizations } from '@devflow/db/tables/organizations'
import type { SessionStatus } from '@devflow/db/tables/sessions'
import { sessions } from '@devflow/db/tables/sessions'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { relaunchSessionProcedure as liveRelaunchSessionProcedure } from '../../src/orpc/api/sessions/relaunch'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('api/sessions/relaunch', () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let effectRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let relaunchSessionProcedure: typeof liveRelaunchSessionProcedure
	let organizationId: string
	let otherOrganizationId: string
	const workosOrganizationId = 'org_sessions_relaunch'
	const userId = 'user_sessions_relaunch'
	const hostId = uuidv7()
	const originalPrompt = 'Fix the launch failure using the original instructions.'

	beforeAll(async () => {
		const testDb = await createTestDb('sessions_relaunch')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		effectRuntime = createRuntimeWithTestPostgresLayer(db)
		relaunchSessionProcedure = bindProcedureToRuntime(liveRelaunchSessionProcedure, effectRuntime)
		const [org, otherOrg] = await db
			.insert(organizations)
			.values([
				{ name: 'Sessions Relaunch', workos_organization_id: workosOrganizationId },
				{ name: 'Other Sessions Relaunch', workos_organization_id: 'org_sessions_relaunch_other' },
			])
			.returning()
		if (!org || !otherOrg) throw new Error('Unable to create relaunch test organizations')
		organizationId = org.id
		otherOrganizationId = otherOrg.id
		await db.insert(onlineHosts).values({ host_id: hostId, user_id: userId, organization_id: organizationId })
	}, 60000)

	afterAll(async () => {
		await effectRuntime?.dispose()
		await cleanupTestDb?.()
	}, 30000)

	function makeContext(actorUserId = userId, actorOrganizationId = organizationId) {
		return createMockApiContext({
			auth: createMockApiAuth({ userId: actorUserId, organizationId: actorOrganizationId, workosOrganizationId }),
			services: { db, dbReadReplica: db },
		})
	}

	async function createSession(status: SessionStatus, codingAgentSessionId: string | null = null) {
		const sessionId = uuidv7()
		await db.insert(sessions).values({
			id: sessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			status,
			coding_agent_session_id: codingAgentSessionId,
			prompt: originalPrompt,
			working_directory: tmpdir(),
			error_message: 'The agent could not launch',
			error_reason: 'start_failed',
			last_activity_at: 1n,
			num_events: 1,
		})
		return sessionId
	}

	async function readSession(sessionId: string) {
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		if (!session) throw new Error('Missing relaunch test session')
		return session
	}

	test.each(['failed', 'lost'] as const)(
		'requeues %s and preserves the original prompt and event',
		async (status) => {
			const sessionId = await createSession(status)
			await db.insert(conversationEvents).values({
				session_id: sessionId,
				organization_id: organizationId,
				resource_owner_user_id: userId,
				user_id: userId,
				event_type: 'message',
				role: 'user',
				content: originalPrompt,
			})
			const before = await readSession(sessionId)
			const eventsBefore = await db
				.select()
				.from(conversationEvents)
				.where(eq(conversationEvents.session_id, sessionId))
			const earliestRelaunch = BigInt(Date.now())
			const result = await call(relaunchSessionProcedure, { sessionId }, { context: makeContext() })
			expect(result).toMatchObject({ success: true, transactionId: expect.any(String) })
			const after = await readSession(sessionId)
			expect(after).toMatchObject({
				status: 'ready_for_launch',
				error_message: null,
				error_reason: null,
				prompt: before.prompt,
				coding_agent_session_id: null,
				num_events: before.num_events,
				host_id: before.host_id,
			})
			expect(after.last_activity_at).toBeGreaterThanOrEqual(earliestRelaunch)
			const eventsAfter = await db
				.select()
				.from(conversationEvents)
				.where(eq(conversationEvents.session_id, sessionId))
			expect(eventsAfter).toEqual(eventsBefore)
		},
	)

	test.each<SessionStatus>([
		'draft',
		'ready_for_launch',
		'waiting_for_workspace',
		'launching',
		'running',
		'resuming',
		'waiting_for_usage_limit',
		'needs_approval',
		'interrupt_requested',
		'interrupted',
		'ready_for_input',
	])('rejects %s without changing the session', async (status) => {
		const sessionId = await createSession(status)
		const before = await readSession(sessionId)
		await expect(call(relaunchSessionProcedure, { sessionId }, { context: makeContext() })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		})
		expect(await readSession(sessionId)).toEqual(before)
	})

	test.each(['failed', 'lost'] as const)('rejects %s once an agent conversation exists', async (status) => {
		const sessionId = await createSession(status, 'existing-agent-conversation')
		const before = await readSession(sessionId)
		await expect(call(relaunchSessionProcedure, { sessionId }, { context: makeContext() })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		})
		expect(await readSession(sessionId)).toEqual(before)
	})

	test('requires prompt access without mutating a forbidden session', async () => {
		const sessionId = await createSession('failed')
		const before = await readSession(sessionId)
		await expect(
			call(relaunchSessionProcedure, { sessionId }, { context: makeContext('another-user') }),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(await readSession(sessionId)).toEqual(before)
	})

	test('returns not found for missing sessions and sessions in another organization', async () => {
		await expect(
			call(relaunchSessionProcedure, { sessionId: uuidv7() }, { context: makeContext() }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' })
		const sessionId = await createSession('failed')
		const before = await readSession(sessionId)
		await expect(
			call(relaunchSessionProcedure, { sessionId }, { context: makeContext(userId, otherOrganizationId) }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' })
		expect(await readSession(sessionId)).toEqual(before)
	})

	test('serializes simultaneous retries and rejects later retries once queued', async () => {
		const sessionId = await createSession('failed')
		const results = await Promise.allSettled([
			call(relaunchSessionProcedure, { sessionId }, { context: makeContext() }),
			call(relaunchSessionProcedure, { sessionId }, { context: makeContext() }),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const rejected = results.find((result) => result.status === 'rejected')
		expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'BAD_REQUEST' } })
		expect(await readSession(sessionId)).toMatchObject({ status: 'ready_for_launch', prompt: originalPrompt })
		await expect(call(relaunchSessionProcedure, { sessionId }, { context: makeContext() })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		})
	})
})
