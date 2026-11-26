import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { sessions } from '@devflow/db/tables/sessions'
import { taskUserAcl } from '@devflow/db/tables/task-user-acl'
import { tasks } from '@devflow/db/tables/tasks'
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

async function session(ownerId = userId, source?: { id: string; at: bigint }) {
	const [row] = await testDb.db
		.insert(sessions)
		.values({
			organization_id: organizationId,
			resource_owner_user_id: ownerId,
			created_by: userId,
			host_id: hostId,
			working_directory: tmpdir(),
			status: 'ready_for_input',
			handoff_source_session_id: source?.id,
			created_at: source?.at,
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

function lookup(
	sessionId: string,
	auth: { hostId?: string; userId?: string; organizationId?: string } = {},
	includeConversation?: boolean,
) {
	return call(
		workflowSkillProcedure,
		{ sessionId, includeConversation },
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
	await testDb.db
		.update(sessions)
		.set({ handoff_source_session_id: other, created_at: 1n })
		.where(eq(sessions.id, id))
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
			content: index === 29 ? 'x'.repeat(16_384) + 'Which one?' : String(index),
		})),
	)
	const { conversation } = await lookup(id)
	expect(conversation).toHaveLength(12)
	expect(conversation[0]?.content).toBe('18')
	expect(conversation.at(-1)?.content).toMatch(/^x+\n\[…\]\nx+Which one\?$/)
	expect(conversation.at(-1)?.content.length).toBeLessThan(8_200)
})

test('replays the conversations and exact skill inherited at each handoff', async () => {
	const source = await session()
	const middle = await session(userId, { id: source, at: 10n })
	const current = await session(userId, { id: middle, at: 20n })
	const event = { organization_id: organizationId, resource_owner_user_id: userId }
	const skill = { ...event, event_type: 'tool_call' as const, role: 'assistant' as const, tool_name: 'Skill' }
	const message = { ...event, event_type: 'message' as const }
	const choices =
		'A: ' +
		'first choice rationale '.repeat(115) +
		'B: second choice. C: calibrated mesh. ' +
		'comparison '.repeat(180)
	await testDb.db.insert(conversationEvents).values([
		{ ...skill, session_id: source, created_at: 2n, tool_input_json: { skill: 'rpi:iterate-prd' } },
		{ ...message, session_id: source, created_at: 1n, role: 'user', content: 'Original request' },
		{ ...message, session_id: source, created_at: 3n, role: 'assistant', content: choices },
		{ ...message, session_id: source, created_at: 4n, role: 'user', content: 'Use option C' },
		{ ...message, session_id: source, created_at: 11n, role: 'assistant', content: 'Later source reply' },
		{ ...skill, session_id: source, created_at: 12n, tool_input_json: { skill: 'rpi:implement-plan' } },
		{ ...message, session_id: middle, created_at: 10n, role: 'user', content: 'First handoff wrapper' },
		{ ...message, session_id: middle, created_at: 13n, role: 'assistant', content: 'What is the measurement?' },
		{
			...message,
			session_id: middle,
			created_at: 18n,
			role: 'assistant',
			content: 'Nested question',
			parent_tool_use_id: 'subagent',
		},
		{ ...skill, session_id: middle, created_at: 21n, tool_input_json: { skill: 'rpi:create-tdd' } },
		{ ...message, session_id: current, created_at: 20n, role: 'user', content: 'Second handoff wrapper' },
	])
	const inherited = [
		{ role: 'user', content: 'Original request' },
		{ role: 'assistant', content: choices },
		{ role: 'user', content: 'Use option C' },
		{ role: 'assistant', content: 'What is the measurement?' },
	]
	expect(await lookup(current)).toEqual({ skill: 'iterate-prd', conversation: inherited })

	await testDb.db.insert(conversationEvents).values([
		{ ...skill, session_id: current, created_at: 22n, tool_input_json: { skill: 'rpi:iterate-tdd' } },
		{
			...message,
			session_id: current,
			created_at: 23n,
			role: 'assistant',
			content: 'Which design should we compare?',
		},
		{ ...message, session_id: current, created_at: 24n, role: 'user', content: 'Compare the two' },
	])
	expect(await lookup(current)).toEqual({
		skill: 'iterate-tdd',
		conversation: [...inherited, { role: 'assistant', content: 'Which design should we compare?' }],
	})
})

test('replays a handoff with no RPI skill and stops at a mismatched owner or cycle', async () => {
	const outside = await session('another-owner')
	const source = await session(userId, { id: outside, at: 10n })
	const current = await session(userId, { id: source, at: 20n })
	const message = { organization_id: organizationId, resource_owner_user_id: userId, event_type: 'message' as const }
	await testDb.db.insert(conversationEvents).values([
		{ ...message, session_id: outside, created_at: 1n, role: 'assistant', content: 'Other owner choice' },
		{ ...message, session_id: source, created_at: 10n, role: 'user', content: 'Source wrapper' },
		{ ...message, session_id: source, created_at: 11n, role: 'assistant', content: 'C is the third design' },
		{ ...message, session_id: current, created_at: 20n, role: 'user', content: 'Destination wrapper' },
		{ ...message, session_id: current, created_at: 21n, role: 'assistant', content: 'Which design?' },
		{ ...message, session_id: current, created_at: 22n, role: 'user', content: 'C' },
	])
	const expected = {
		skill: null,
		conversation: [
			{ role: 'assistant', content: 'C is the third design' },
			{ role: 'assistant', content: 'Which design?' },
		],
	}
	expect(await lookup(current)).toEqual(expected)
	await testDb.db.update(sessions).set({ handoff_source_session_id: current }).where(eq(sessions.id, source))
	expect(await lookup(current)).toEqual(expected)
})

test('cold resumes can restore ordinary dialogue and warm processes can request the skill alone', async () => {
	const id = await session()
	const message = {
		session_id: id,
		organization_id: organizationId,
		resource_owner_user_id: userId,
		event_type: 'message' as const,
	}
	await testDb.db.insert(conversationEvents).values([
		{ ...message, created_at: 1n, role: 'user', content: 'Initial request' },
		{ ...message, created_at: 2n, role: 'assistant', content: 'Should we use the first or second?' },
		{ ...message, created_at: 3n, role: 'user', content: 'Second' },
	])
	expect(await lookup(id)).toEqual({ skill: null, conversation: [] })
	expect(await lookup(id, {}, true)).toEqual({
		skill: null,
		conversation: [
			{ role: 'user', content: 'Initial request' },
			{ role: 'assistant', content: 'Should we use the first or second?' },
		],
	})
	await testDb.db.insert(conversationEvents).values({
		...message,
		event_type: 'tool_call',
		role: 'assistant',
		tool_name: 'Skill',
		tool_input_json: { skill: 'rpi:create-prd' },
	})
	expect(await lookup(id, {}, false)).toEqual({ skill: 'create-prd', conversation: [] })
	expect((await lookup(id)).conversation).toHaveLength(2)
})

test('restores through a moved session while the user can edit both tasks', async () => {
	const original = await sessionWithPrd()
	const handoffAt = BigInt(Date.now()) + 1n
	const source = await session(userId, { id: original, at: handoffAt })
	const current = await session(userId, { id: source, at: handoffAt + 2n })
	const originalTask = randomUUID()
	const newTask = randomUUID()
	const otherOwner = 'shared-task-owner'
	await testDb.db.insert(tasks).values([
		{
			id: originalTask,
			organization_id: organizationId,
			name: 'Original task',
			created_by: otherOwner,
			resource_owner_user_id: otherOwner,
		},
		{
			id: newTask,
			organization_id: organizationId,
			name: 'Moved task',
			created_by: userId,
			resource_owner_user_id: userId,
		},
	])
	await testDb.db.insert(taskUserAcl).values({
		task_id: originalTask,
		organization_id: organizationId,
		subject_user_id: userId,
		resource_owner_user_id: otherOwner,
		granted_by: otherOwner,
		permission_level: 'edit',
	})
	await testDb.db
		.update(sessions)
		.set({ task_id: originalTask, resource_owner_user_id: otherOwner })
		.where(eq(sessions.id, source))
	await testDb.db.update(sessions).set({ task_id: newTask }).where(eq(sessions.id, current))
	const question = 'Should controls have defaults?'
	await testDb.db.insert(conversationEvents).values({
		session_id: source,
		organization_id: organizationId,
		resource_owner_user_id: otherOwner,
		created_at: handoffAt + 1n,
		role: 'assistant',
		event_type: 'message',
		content: question,
	})
	expect(await lookup(current)).toEqual({
		skill: 'create-prd',
		conversation: [{ role: 'assistant', content: question }],
	})
	await testDb.db.update(taskUserAcl).set({ permission_level: 'read' }).where(eq(taskUserAcl.task_id, originalTask))
	expect(await lookup(current)).toEqual({ skill: null, conversation: [] })
})
