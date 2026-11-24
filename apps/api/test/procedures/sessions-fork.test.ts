import { randomUUID } from 'node:crypto'

import {
	ForkSessionInputSchema,
	ForkSessionOutputSchema,
	LegacyClaudeForkMetadataSchema,
} from '@devflow/api-contract/api/sessions/fork'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { organizations } from '@devflow/db/tables/organizations'
import { type PermissionsMode, type SessionLabel, sessionSelectSchema, sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import z from 'zod/v4'

import { forkSessionProcedure, forkSessionV2Procedure } from '../../src/orpc/api/sessions/fork'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('api/sessions/fork', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase

	let organizationId: string
	const workosOrganizationId = 'org_sessions_fork'
	const userId = 'user_sessions_fork'
	const hostId = randomUUID()

	let taskId: string
	let sourceSessionId: string
	let forkAtEventId: string

	beforeAll(async () => {
		const testDb = await createTestDb('sessions_fork')
		cleanupTestDb = testDb.cleanup
		db = testDb.db

		// Set up organization
		const [org] = await db
			.insert(organizations)
			.values({
				name: 'session fork test org',
				workos_organization_id: workosOrganizationId,
			})
			.returning()

		if (!org) throw new Error('Unable to insert organization for setup')
		organizationId = org.id

		// Set up task
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: 'fork test task',
				resource_owner_user_id: userId,
				created_by: userId,
			})
			.returning()

		if (!task) throw new Error('Unable to insert task for setup')
		taskId = task.id

		// Register host for ownership validation
		await db.insert(onlineHosts).values({
			host_id: hostId,
			user_id: userId,
			organization_id: organizationId,
		})

		// Create source session with coding_agent_session_id
		sourceSessionId = uuidv7()
		await db.insert(sessions).values({
			id: sourceSessionId,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			coding_agent: 'claude',
			status: 'ready_for_input',
			coding_agent_session_id: randomUUID(),
			provider: 'anthropic',
			model: 'opus',
			permissions_mode: 'default',
			title: 'My Session',
		})

		// Create conversation history on the source session:
		// 1. An assistant message with a coding_agent_event_id (the preceding event)
		const precedingEventId = uuidv7()
		const now = BigInt(Date.now())
		await db.insert(conversationEvents).values({
			id: precedingEventId,
			session_id: sourceSessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'assistant',
			content: 'Here is my response',
			coding_agent_event_id: randomUUID(),
			created_at: now,
			updated_at: now,
		})

		// 2. A user message that will be the fork point
		forkAtEventId = uuidv7()
		const laterTime = BigInt(Date.now() + 1000)
		await db.insert(conversationEvents).values({
			id: forkAtEventId,
			session_id: sourceSessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'Follow-up question',
			created_at: laterTime,
			updated_at: laterTime,
		})
	}, 60000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	test('fork contract schemas parse the legacy client input and output shapes', () => {
		const input = ForkSessionInputSchema.parse({
			id: uuidv7(),
			eventId: uuidv7(),
			sourceSessionId,
			forkAtEventId,
			text: 'Fork prompt',
			title: null,
			archiveSource: false,
		})

		expect(input).toEqual({
			id: expect.any(String),
			eventId: expect.any(String),
			sourceSessionId,
			forkAtEventId,
			text: 'Fork prompt',
			title: null,
			archiveSource: false,
		})

		const session = sessionSelectSchema.parse({
			id: uuidv7(),
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			status: 'ready_for_launch',
			created_at: BigInt(Date.now()),
			updated_at: BigInt(Date.now()),
			last_activity_at: BigInt(Date.now()),
			num_events: 0,
			context_window_tokens: 0,
			title: 'My Session (fork)',
			summary: null,
			provider: 'anthropic',
			model: 'opus',
			resolved_model: null,
			effort: null,
			fast_mode: false,
			model_usage: null,
			total_cost_usd: null,
			applied_usage_report_keys: null,
			error_message: null,
			error_reason: null,
			permissions_mode: 'default',
			context_window_limit: null,
			is_compacting: false,
			archived: false,
			workflow_type: null,
			prompt: 'Fork prompt',
			forked_from_session_id: sourceSessionId,
			handoff_source_session_id: null,
			coding_agent: 'claude',
			coding_agent_session_id: null,
			fork_data: null,
			labels: [],
			next_step_suggestions: null,
			structured_summary: null,
			multiplayer_prompting_user_ids: [],
			multiplayer_prompting_started_at: null,
			multiplayer_prompting_expires_at: null,
		})

		const output = ForkSessionOutputSchema.parse({ transactionId: uuidv7(), session })

		expect(output).toEqual({ transactionId: expect.any(String), session })
	})

	function makeContext(uid = userId) {
		return createMockApiContext({
			auth: createMockApiAuth({ userId: uid, organizationId, workosOrganizationId }),
			services: { db, dbReadReplica: db },
		})
	}

	async function insertConversationEventsInBatches(rows: Array<typeof conversationEvents.$inferInsert>) {
		const batchSize = 1000
		for (let i = 0; i < rows.length; i += batchSize) {
			await db.insert(conversationEvents).values(rows.slice(i, i + batchSize))
		}
	}

	async function createRunIndexedSession(options: { archiveTitle?: string | null; labels?: SessionLabel[] } = {}) {
		const id = uuidv7()
		const now = BigInt(Date.now())
		await db.insert(sessions).values({
			id,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			coding_agent: 'codelayer',
			status: 'ready_for_input',
			provider: 'anthropic',
			model: 'opus',
			permissions_mode: 'default',
			title: options.archiveTitle ?? 'CodeLayer Session',
			...(options.labels ? { labels: options.labels } : {}),
		})

		const firstUserEventId = uuidv7()
		await db.insert(conversationEvents).values({
			id: firstUserEventId,
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'First user turn',
			run_index: 0,
			created_at: now,
			updated_at: now,
		})

		const assistantEventId = uuidv7()
		await db.insert(conversationEvents).values({
			id: assistantEventId,
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'assistant',
			content: 'Assistant response',
			created_at: now + 100n,
			updated_at: now + 100n,
		})

		const forkAtEventId = uuidv7()
		await db.insert(conversationEvents).values({
			id: forkAtEventId,
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'Second user turn',
			run_index: 1,
			created_at: now + 200n,
			updated_at: now + 200n,
		})

		return { sessionId: id, firstUserEventId, assistantEventId, forkAtEventId }
	}

	async function createForkableSession(
		options: { title?: string | null; permissions_mode?: PermissionsMode; labels?: SessionLabel[] } = {},
	) {
		const id = uuidv7()
		await db.insert(sessions).values({
			id,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			coding_agent: 'claude',
			status: 'ready_for_input',
			coding_agent_session_id: randomUUID(),
			provider: 'anthropic',
			model: 'opus',
			permissions_mode: options.permissions_mode ?? 'default',
			...(options.labels ? { labels: options.labels } : {}),
			...(options.title !== undefined ? { title: options.title } : {}),
		})

		const now = BigInt(Date.now())
		await db.insert(conversationEvents).values({
			id: uuidv7(),
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'assistant',
			content: 'Response',
			coding_agent_event_id: randomUUID(),
			created_at: now,
			updated_at: now,
		})

		const eventId = uuidv7()
		const laterTime = BigInt(Date.now() + 1000)
		await db.insert(conversationEvents).values({
			id: eventId,
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'User message',
			created_at: laterTime,
			updated_at: laterTime,
		})

		return { sessionId: id, forkAtEventId: eventId }
	}

	test('claude fork writes legacy fork_data fork metadata', async () => {
		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId,
				forkAtEventId,
				text: 'Legacy metadata fork',
			},
			{ context: makeContext() },
		)

		const [created] = await db.select().from(sessions).where(eq(sessions.id, result.session.id)).limit(1)
		const forkData = created!.fork_data as { fork?: unknown }
		const fork = LegacyClaudeForkMetadataSchema.parse(forkData.fork)

		expect(Object.keys(fork).sort()).toEqual(['forkAtCodingAgentEventId', 'forkFromCodingAgentSessionId'])
		expect('agent' in fork).toBe(false)
	})

	test('forks session successfully', async () => {
		const source = await createForkableSession({ title: `My Session ${uuidv7()}` })
		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'New direction after fork',
			},
			{ context: makeContext() },
		)

		expect(result.session).toBeDefined()
		expect(result.session.forked_from_session_id).toBe(source.sessionId)
		expect(result.transactionId).toBeTypeOf('string')
		expect(result.session.title).toBeDefined()
		expect(result.session.title).toMatch(/\(fork 1\)$/)
	})

	test('fork inherits labels from source session', async () => {
		const labels = [{ name: 'rpi:design-tdd', title: 'design-tdd' }]
		const source = await createForkableSession({ title: `Label Source ${uuidv7()}`, labels })

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Fork with labels',
			},
			{ context: makeContext() },
		)

		expect(result.session.labels).toEqual(labels)
	})

	test('forks session with more than one insert worth of conversation history', async () => {
		const largeSourceSessionId = uuidv7()
		await db.insert(sessions).values({
			id: largeSourceSessionId,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			coding_agent: 'claude',
			status: 'ready_for_input',
			coding_agent_session_id: randomUUID(),
			provider: 'anthropic',
			model: 'opus-1m',
			permissions_mode: 'default',
			title: 'Large History Source',
		})

		const copiedEventCount = 2600
		const baseTime = BigInt(Date.now())
		const sourceEvents = Array.from({ length: copiedEventCount }, (_, index) => ({
			id: uuidv7(),
			session_id: largeSourceSessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message' as const,
			role: index % 2 === 0 ? ('assistant' as const) : ('user' as const),
			content: `Large history event ${index}`,
			coding_agent_event_id: index === 0 ? randomUUID() : null,
			created_at: baseTime + BigInt(index),
			updated_at: baseTime + BigInt(index),
		}))
		await insertConversationEventsInBatches(sourceEvents)

		const largeForkAtEventId = uuidv7()
		await db.insert(conversationEvents).values({
			id: largeForkAtEventId,
			session_id: largeSourceSessionId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'Large history fork point should not be copied',
			created_at: baseTime + BigInt(copiedEventCount),
			updated_at: baseTime + BigInt(copiedEventCount),
		})

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: largeSourceSessionId,
				forkAtEventId: largeForkAtEventId,
				text: 'Fork from a large history',
			},
			{ context: makeContext() },
		)

		expect(result.session).toBeDefined()
		expect(result.session.forked_from_session_id).toBe(largeSourceSessionId)
		expect(result.transactionId).toBeTypeOf('string')

		const childEvents = await db
			.select()
			.from(conversationEvents)
			.where(eq(conversationEvents.session_id, result.session.id))
			.orderBy(conversationEvents.created_at)

		expect(childEvents).toHaveLength(copiedEventCount + 1)
		expect(childEvents.some((event) => event.content === 'Large history fork point should not be copied')).toBe(
			false,
		)
		expect(childEvents.map((event) => event.content)).toContain('Large history event 0')
		expect(childEvents.map((event) => event.content)).toContain(`Large history event ${copiedEventCount - 1}`)
	})

	test('archives source session when archiveSource is true', async () => {
		// Create a fresh source session to archive
		const archiveSourceId = uuidv7()
		await db.insert(sessions).values({
			id: archiveSourceId,
			task_id: taskId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			created_by: userId,
			host_id: hostId,
			working_directory: '/tmp/fork-test',
			coding_agent: 'claude',
			status: 'ready_for_input',
			coding_agent_session_id: randomUUID(),
			provider: 'anthropic',
			model: 'opus',
			permissions_mode: 'default',
			title: 'Archive Source',
		})

		// Add conversation events to the new source session
		const now = BigInt(Date.now())
		await db.insert(conversationEvents).values({
			id: uuidv7(),
			session_id: archiveSourceId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'assistant',
			content: 'Response',
			coding_agent_event_id: randomUUID(),
			created_at: now,
			updated_at: now,
		})

		const archiveForkEventId = uuidv7()
		const laterTime = BigInt(Date.now() + 1000)
		await db.insert(conversationEvents).values({
			id: archiveForkEventId,
			session_id: archiveSourceId,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message',
			role: 'user',
			content: 'User message',
			created_at: laterTime,
			updated_at: laterTime,
		})

		await call(
			forkSessionProcedure,
			{
				sourceSessionId: archiveSourceId,
				forkAtEventId: archiveForkEventId,
				text: 'Fork and archive',
				archiveSource: true,
			},
			{ context: makeContext() },
		)

		const [source] = await db.select().from(sessions).where(eq(sessions.id, archiveSourceId)).limit(1)

		expect(source!.archived).toBe(true)
	})

	test('rejects fork for non-existent source session', async () => {
		await expect(
			call(
				forkSessionProcedure,
				{
					sourceSessionId: uuidv7(),
					forkAtEventId,
					text: 'Should fail',
				},
				{ context: makeContext() },
			),
		).rejects.toThrow()
	})

	test('rejects fork at non-existent event', async () => {
		await expect(
			call(
				forkSessionProcedure,
				{
					sourceSessionId,
					forkAtEventId: uuidv7(),
					text: 'Should fail',
				},
				{ context: makeContext() },
			),
		).rejects.toThrow()
	})

	test('produces incrementing fork numbers', async () => {
		const source = await createForkableSession({ title: 'Increment Test' })

		const result1 = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Fork 1',
			},
			{ context: makeContext() },
		)
		expect(result1.session.title).toBe('Increment Test (fork 1)')

		const result2 = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Fork 2',
			},
			{ context: makeContext() },
		)
		expect(result2.session.title).toBe('Increment Test (fork 2)')
	})

	test('strips existing fork suffix before numbering', async () => {
		// Create a session titled "X" and fork it to get "X (fork 1)"
		const source = await createForkableSession({ title: 'Strip Test' })

		const fork1 = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'First fork',
			},
			{ context: makeContext() },
		)
		expect(fork1.session.title).toBe('Strip Test (fork 1)')

		// Now fork "Strip Test (fork 1)" — should strip suffix and produce "Strip Test (fork 2)"
		const fork1Source = await createForkableSession({ title: 'Strip Test (fork 1)' })

		const fork2 = await call(
			forkSessionProcedure,
			{
				sourceSessionId: fork1Source.sessionId,
				forkAtEventId: fork1Source.forkAtEventId,
				text: 'Fork of fork',
			},
			{ context: makeContext() },
		)
		expect(fork2.session.title).toBe('Strip Test (fork 2)')
	})

	test('handles null source title', async () => {
		const source = await createForkableSession({ title: null })

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Fork with no title',
			},
			{ context: makeContext() },
		)
		expect(result.session.title).toBe('(fork 1)')
	})

	test('counts legacy unnumbered (fork) suffix', async () => {
		// Seed a session with legacy "(fork)" title
		await createForkableSession({ title: 'Legacy Test (fork)' })

		// Fork a session titled "Legacy Test" — should count the existing (fork) as 1
		const source = await createForkableSession({ title: 'Legacy Test' })

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'After legacy',
			},
			{ context: makeContext() },
		)
		expect(result.session.title).toBe('Legacy Test (fork 2)')
	})

	test.each(['codelayer', 'fold'] as const)(
		'rejects a %s fork without creating a child session',
		async (codingAgent) => {
			const source = await createRunIndexedSession()
			await db.update(sessions).set({ coding_agent: codingAgent }).where(eq(sessions.id, source.sessionId))
			const childSessionId = uuidv7()

			await expect(
				call(
					forkSessionV2Procedure,
					{
						id: childSessionId,
						codingAgent,
						sourceSessionId: source.sessionId,
						forkAtEventId: source.forkAtEventId,
						text: 'Not available',
					},
					{ context: makeContext() },
				),
			).rejects.toThrow('FORK_FAILED')

			expect(await db.select().from(sessions).where(eq(sessions.id, childSessionId))).toHaveLength(0)
		},
	)

	test('respects explicit title from client', async () => {
		const source = await createForkableSession({ title: 'Override Test' })

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Custom title fork',
				title: 'My Custom Title',
			},
			{ context: makeContext() },
		)
		expect(result.session.title).toBe('My Custom Title')
	})

	test('fork inherits permissions_mode: auto from source session', async () => {
		const source = await createForkableSession({ title: 'Auto Mode Source', permissions_mode: 'auto' })

		const result = await call(
			forkSessionProcedure,
			{
				sourceSessionId: source.sessionId,
				forkAtEventId: source.forkAtEventId,
				text: 'Fork from auto session',
			},
			{ context: makeContext() },
		)

		expect(result.session.permissions_mode).toBe('auto')
	})
})
