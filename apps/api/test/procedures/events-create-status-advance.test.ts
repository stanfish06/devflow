// File: apps/api/test/procedures/events-create-status-advance.test.ts

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { organizations } from '@devflow/db/tables/organizations'
import { sessions, type SessionStatus } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createEventProcedure } from '../../src/orpc/daemon/sessions/events/create'
import { createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('Events create: session status repair', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let organizationId: string
	const userId = 'user_status_advance'
	const hostId = randomUUID()

	beforeAll(async () => {
		const testDb = await createTestDb('events_create_status_advance')
		cleanupTestDb = testDb.cleanup
		db = testDb.db

		const [org] = await db
			.insert(organizations)
			.values({
				name: 'test organization status advance',
				workos_organization_id: 'org_status_advance_test',
			})
			.returning()
		if (!org) throw new Error('Unable to insert organization for setup')
		organizationId = org.id
	}, 30000)

	async function createTaskAndSession(opts: { name: string; status?: SessionStatus; errorMessage?: string }) {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: opts.name,
				slug: opts.name,
				resource_owner_user_id: userId,
				created_by: userId,
				default_working_directory: tmpdir(),
				setup_status: 'completed',
			})
			.returning()

		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: organizationId,
				resource_owner_user_id: userId,
				created_by: userId,
				host_id: hostId,
				task_id: task!.id,
				title: opts.name,
				working_directory: tmpdir(),
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissions_mode: 'default',
				status: opts.status ?? 'ready_for_input',
				error_message: opts.errorMessage,
			})
			.returning()

		return { task: task!, session: session! }
	}

	test.each([
		{ eventType: 'message' as const, role: 'assistant' as const },
		{ eventType: 'thinking' as const, role: 'assistant' as const },
		{ eventType: 'tool_call' as const, role: 'assistant' as const },
		{ eventType: 'tool_result' as const, role: 'user' as const },
	])('$eventType/$role restores every repairable session state to running', async ({ eventType, role }) => {
		const repairableStatuses: SessionStatus[] = [
			'lost',
			'failed',
			'interrupted',
			'ready_for_input',
			'launching',
			'resuming',
		]
		for (const status of repairableStatuses) {
			const { session } = await createTaskAndSession({
				name: `repair-${eventType}-${status}-${randomUUID()}`,
				status,
				errorMessage: 'stale warning',
			})
			const previousActivity = session.last_activity_at

			await call(
				createEventProcedure,
				{
					sessionId: session.id,
					codingAgentSessionId: 'repair-agent-session',
					eventType,
					role,
					...(eventType === 'tool_call' ? { toolCallId: randomUUID(), toolName: 'Bash' } : {}),
					...(eventType === 'tool_result'
						? { toolResultForId: randomUUID(), toolResultContent: 'done' }
						: {}),
				},
				{ context: daemonContext() },
			)

			const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(updated).toMatchObject({ status: 'running', error_message: null, num_events: 1 })
			expect(updated!.last_activity_at).toBeGreaterThanOrEqual(previousActivity)
		}
	})

	test.each([
		{ eventType: 'message' as const, role: 'user' as const },
		{ eventType: 'system' as const, role: 'assistant' as const },
		{ eventType: 'tool_result' as const, role: 'assistant' as const },
	])('$eventType/$role records activity without repairing status', async ({ eventType, role }) => {
		const { session } = await createTaskAndSession({
			name: `non-repair-${eventType}-${role}-${randomUUID()}`,
			status: 'lost',
			errorMessage: 'lost warning',
		})

		await call(
			createEventProcedure,
			{
				sessionId: session.id,
				codingAgentSessionId: 'non-repair-agent-session',
				eventType,
				role,
				...(eventType === 'tool_result' ? { toolResultForId: randomUUID(), toolResultContent: 'done' } : {}),
			},
			{ context: daemonContext() },
		)

		const [updated] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(updated).toMatchObject({ status: 'lost', error_message: 'lost warning', num_events: 1 })
	})

	function daemonContext() {
		return createMockDaemonContext({
			auth: createMockDaemonAuth({ userId, organizationId, hostId }),
			services: { db, dbReadReplica: db },
		})
	}

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)
})
