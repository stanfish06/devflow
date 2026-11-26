import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { sessions } from '@devflow/db/tables/sessions'
import { call } from '@orpc/server'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { workflowSkillProcedure } from '../../src/orpc/daemon/sessions/workflow-skill'
import { createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { createTestDb } from '../utils/test-db'

let testDb: Awaited<ReturnType<typeof createTestDb>>
let organizationId: string
const userId = 'workflow-owner'
const hostId = randomUUID()

beforeAll(async () => {
	testDb = await createTestDb('workflow_skill')
	const [org] = await testDb.db
		.insert(organizations)
		.values({
			name: 'workflow skill tests',
			workos_organization_id: 'org_workflow_skill',
		})
		.returning()
	if (!org) throw new Error('Could not create test organization')
	organizationId = org.id
}, 30_000)

afterAll(async () => {
	await testDb?.cleanup()
}, 30_000)

async function session(ownerId = userId) {
	const [row] = await testDb.db
		.insert(sessions)
		.values({
			organization_id: organizationId,
			resource_owner_user_id: ownerId,
			created_by: userId,
			host_id: hostId,
			working_directory: tmpdir(),
			status: 'ready_for_input',
		})
		.returning()
	if (!row) throw new Error('Could not create test session')
	return row.id
}

async function sessionWithPrd() {
	const id = await session()
	await testDb.db.insert(conversationEvents).values({
		session_id: id,
		organization_id: organizationId,
		resource_owner_user_id: userId,
		event_type: 'tool_call',
		role: 'assistant',
		tool_name: 'Skill',
		tool_input_json: { skill: 'rpi:create-prd' },
	})
	return id
}

function lookup(sessionId: string, auth: { hostId?: string; userId?: string; organizationId?: string } = {}) {
	return call(
		workflowSkillProcedure,
		{ sessionId },
		{
			context: createMockDaemonContext({
				auth: createMockDaemonAuth({ userId, hostId, organizationId, ...auth }),
				services: { db: testDb.db, dbReadReplica: testDb.db },
			}),
		},
	)
}

test('restores the most recent recognized root skill without adding events', async () => {
	const sessionId = await session()
	expect(await lookup(sessionId)).toEqual({ skill: null, conversation: [] })
	const event = {
		session_id: sessionId,
		organization_id: organizationId,
		resource_owner_user_id: userId,
		event_type: 'tool_call' as const,
		role: 'assistant' as const,
		tool_name: 'Skill',
	}
	await testDb.db.insert(conversationEvents).values([
		{ ...event, created_at: 1n, tool_input_json: { skill: 'rpi:create-prd' } },
		{ ...event, created_at: 2n, tool_name: 'skill', tool_input_json: JSON.stringify({ name: 'iterate-prd' }) },
		{ ...event, created_at: 3n, tool_input_json: { skill: 'other:iterate-tdd' } },
		{ ...event, created_at: 4n, tool_input_json: { skill: 'rpi:create-tdd' }, parent_tool_use_id: 'subagent' },
		{ ...event, created_at: 5n, tool_input_json: { skill: '../create-prd' } },
	])
	expect(await lookup(sessionId)).toEqual({ skill: 'iterate-prd', conversation: [] })
	expect(await lookup(sessionId)).toEqual({ skill: 'iterate-prd', conversation: [] })
	const [row] = await testDb.db
		.select({ count: count() })
		.from(conversationEvents)
		.where(eq(conversationEvents.session_id, sessionId))
	expect(row?.count).toBe(5)
})

test('enforces organization, host, creating user and edit permission', async () => {
	const id = await session()
	await expect(lookup(id, { organizationId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' })
	await expect(lookup(id, { hostId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
	await expect(lookup(id, { userId: 'someone-else' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
	await expect(lookup(await session('another-owner'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('returns completed question and answer exchanges before this dispatch, including batched replies', async () => {
	const id = await sessionWithPrd()
	const other = await session()
	await testDb.db.update(sessions).set({ handoff_source_session_id: other }).where(eq(sessions.id, id))
	const event = {
		session_id: id,
		organization_id: organizationId,
		resource_owner_user_id: userId,
		event_type: 'message' as const,
	}
	await testDb.db.insert(conversationEvents).values([
		{ ...event, created_at: 1n, role: 'user', content: 'Synthetic handoff transcript' },
		{ ...event, created_at: 2n, role: 'assistant', content: 'Which behavior matters?' },
		{ ...event, created_at: 3n, role: 'user', content: 'Simulation output' },
		{ ...event, created_at: 4n, role: 'assistant', content: 'I will read the document.' },
		{ ...event, created_at: 5n, role: 'assistant', content: 'Which measurement demonstrates success?' },
		{ ...event, created_at: 6n, role: 'user', content: 'First part of current reply' },
		{ ...event, created_at: 7n, role: 'user', content: 'Queued second part' },
		{ ...event, created_at: 8n, role: 'assistant', parent_tool_use_id: 'subagent', content: 'Nested agent' },
		{ ...event, created_at: 9n, role: 'assistant', content: '  ' },
		{ ...event, created_at: 10n, role: 'assistant', session_id: other, content: 'Unrelated session' },
	])
	expect(await lookup(other)).toEqual({ skill: null, conversation: [] })
	expect((await lookup(id)).conversation).toEqual([
		{ role: 'assistant', content: 'Which behavior matters?' },
		{ role: 'user', content: 'Simulation output' },
		{ role: 'assistant', content: 'Which measurement demonstrates success?' },
	])
})

test('bounds the number and size of replayed messages and retains the question at the end', async () => {
	const id = await sessionWithPrd()
	await testDb.db.insert(conversationEvents).values(
		Array.from({ length: 30 }, (_, index) => ({
			session_id: id,
			organization_id: organizationId,
			resource_owner_user_id: userId,
			event_type: 'message' as const,
			role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
			created_at: BigInt(index),
			content: index === 29 ? 'x'.repeat(4096) + 'Which one?' : String(index),
		})),
	)
	const { conversation } = await lookup(id)
	expect(conversation).toHaveLength(12)
	expect(conversation[0]?.content).toBe('18')
	expect(conversation.at(-1)?.content).toMatch(/^x+\n\[…\]\nx+Which one\?$/)
	expect(conversation.at(-1)?.content.length).toBeLessThan(2100)
})
