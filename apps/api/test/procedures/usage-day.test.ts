import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { usageDayRowActivity } from '@devflow/api-contract/api/usage/day'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { sessionUsageEvents } from '@devflow/db/tables/session-usage-events'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { call } from '@orpc/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { usageDayProcedure as liveUsageDayProcedure } from '../../src/orpc/api/usage/day.effect'
import { usageYearProcedure as liveUsageYearProcedure } from '../../src/orpc/api/usage/year.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/** The day under test, a Wednesday. */
const DAY = '2026-11-18'
/** 15:00 UTC on a November fixture day: the same local day at offset 0 and at UTC-8. */
const at = (day: number, hourUtc = 15) => BigInt(Date.UTC(2026, 10, day, hourUtc))

describe('usage/day', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let effectRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let usageDayProcedure: typeof liveUsageDayProcedure
	let usageYearProcedure: typeof liveUsageYearProcedure
	let organizationId: string
	let otherOrganizationId: string
	const hostId = randomUUID()

	const ME = `user_usage_me_${randomUUID()}`
	const TEAMMATE = `user_usage_teammate_${randomUUID()}`

	const ids = {
		task: '',
		archivedTask: '',
		scratch: '',
		spendOnly: '',
	}

	const contextFor = (userId: string, orgId: string) =>
		createMockApiContext({
			auth: createMockApiAuth({ userId, organizationId: orgId }),
			services: { db, dbReadReplica: db },
		})

	const callAs = (userId: string, input: { date: string; timezoneOffset?: number }, orgId = organizationId) =>
		call(usageDayProcedure, input, { context: contextFor(userId, orgId) })

	const createTask = async (values: { createdBy: string; createdAt: bigint; name: string; archived?: boolean }) => {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: values.name,
				created_by: values.createdBy,
				resource_owner_user_id: values.createdBy,
				archived: values.archived ?? false,
				created_at: values.createdAt,
				updated_at: values.createdAt,
			})
			.returning()
		if (!task) throw new Error('Unable to insert task for setup')
		return task
	}

	const createSession = async (values: {
		createdBy: string
		createdAt: bigint
		taskId?: string
		orgId?: string
		title?: string
		summary?: string
	}) => {
		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: values.orgId ?? organizationId,
				task_id: values.taskId ?? null,
				created_by: values.createdBy,
				resource_owner_user_id: values.createdBy,
				host_id: hostId,
				working_directory: tmpdir(),
				coding_agent: 'claude',
				status: 'ready_for_input',
				title: values.title ?? null,
				summary: values.summary ?? null,
				created_at: values.createdAt,
				updated_at: values.createdAt,
			})
			.returning()
		if (!session) throw new Error('Unable to insert session for setup')
		return session
	}

	/** A prompt. `taskId` is left off unless given: an event may not carry its session's task. */
	const createPrompt = async (values: {
		sessionId: string
		userId: string | null
		createdAt: bigint
		taskId?: string
		orgId?: string
	}) => {
		await db.insert(conversationEvents).values({
			organization_id: values.orgId ?? organizationId,
			session_id: values.sessionId,
			task_id: values.taskId ?? null,
			resource_owner_user_id: values.userId ?? ME,
			user_id: values.userId,
			role: 'user',
			event_type: 'message',
			content: 'hello',
			created_at: values.createdAt,
			updated_at: values.createdAt,
		})
	}

	/** One ledger row: one run of one model, as the daemon records it. */
	const createUsage = async (values: {
		sessionId: string
		creator: string
		occurredAt: bigint
		taskId?: string
		model?: string
		tokens: [cacheRead: number, cacheWrite: number, input: number, output: number]
		costUsd: number | null
		orgId?: string
	}) => {
		const [cacheRead, cacheWrite, input, output] = values.tokens
		await db.insert(sessionUsageEvents).values({
			session_id: values.sessionId,
			organization_id: values.orgId ?? organizationId,
			resource_owner_user_id: values.creator,
			session_creator_user_id: values.creator,
			task_id: values.taskId ?? null,
			coding_agent: 'claude',
			source: 'claude_sdk_result',
			report_key: `report-${randomUUID()}`,
			model: values.model ?? 'claude-opus-4-5',
			tokens: { input_tokens: input, output_tokens: output },
			input_tokens: input,
			output_tokens: output,
			cache_read_tokens: cacheRead,
			cache_creation_tokens: cacheWrite,
			cost_usd: values.costUsd,
			occurred_at: values.occurredAt,
		})
	}

	beforeAll(async () => {
		const testDb = await createTestDb('usage_day')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		effectRuntime = createRuntimeWithTestPostgresLayer(db)
		usageDayProcedure = bindProcedureToRuntime(liveUsageDayProcedure, effectRuntime)
		usageYearProcedure = bindProcedureToRuntime(liveUsageYearProcedure, effectRuntime)

		const [org] = await db
			.insert(organizations)
			.values({ name: 'Usage Day Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		const [otherOrg] = await db
			.insert(organizations)
			.values({ name: 'Other Usage Day Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		if (!org || !otherOrg) throw new Error('Unable to insert organizations for setup')
		organizationId = org.id
		otherOrganizationId = otherOrg.id

		// The day's main work: a task I created, two sessions in it and three prompts, and a Claude run
		// across two models: 1,200 tokens for $0.12.
		const task = await createTask({ createdBy: ME, createdAt: at(18), name: 'Usage dashboard' })
		ids.task = task.id
		const first = await createSession({ createdBy: ME, createdAt: at(18), taskId: task.id })
		const second = await createSession({ createdBy: ME, createdAt: at(18, 18), taskId: task.id })
		await createPrompt({ sessionId: first.id, userId: ME, createdAt: at(18, 16), taskId: task.id })
		await createPrompt({ sessionId: first.id, userId: ME, createdAt: at(18, 17), taskId: task.id })
		await createPrompt({ sessionId: second.id, userId: ME, createdAt: at(18, 19) })
		await createUsage({
			sessionId: first.id,
			taskId: task.id,
			creator: ME,
			occurredAt: at(18, 17),
			tokens: [500, 100, 300, 50],
			costUsd: 0.1,
		})
		await createUsage({
			sessionId: first.id,
			taskId: task.id,
			creator: ME,
			occurredAt: at(18, 17),
			model: 'claude-haiku-4-5',
			tokens: [100, 0, 100, 50],
			costUsd: 0.02,
		})
		// The daemon's own message in the same session carries no user id: never counted.
		await createPrompt({ sessionId: first.id, userId: null, createdAt: at(18, 17) })

		// An archived task from last week that I came back to with one prompt. The event carries no task
		// id, so the row is found through its session.
		const archived = await createTask({
			createdBy: ME,
			createdAt: at(10),
			name: 'Old investigation',
			archived: true,
		})
		ids.archivedTask = archived.id
		const archivedSession = await createSession({ createdBy: ME, createdAt: at(10), taskId: archived.id })
		await createPrompt({ sessionId: archivedSession.id, userId: ME, createdAt: at(18, 5) })

		// A session with no task, started that day, with one prompt. No ledger rows: "No token data".
		const scratch = await createSession({ createdBy: ME, createdAt: at(18, 10), title: 'Scratch' })
		ids.scratch = scratch.id
		await createPrompt({ sessionId: scratch.id, userId: ME, createdAt: at(18, 11) })

		// A task-less session from last week, untitled but summarised, that only spent tokens that day.
		const spendOnly = await createSession({ createdBy: ME, createdAt: at(10), summary: 'Background refactor' })
		ids.spendOnly = spendOnly.id
		await createUsage({
			sessionId: spendOnly.id,
			creator: ME,
			occurredAt: at(18, 12),
			tokens: [0, 0, 7, 3],
			costUsd: null,
		})

		// A teammate's task that day, and a prompt they sent in MY session: neither is mine.
		const theirTask = await createTask({ createdBy: TEAMMATE, createdAt: at(18), name: 'Their task' })
		const theirSession = await createSession({ createdBy: TEAMMATE, createdAt: at(18), taskId: theirTask.id })
		await createPrompt({ sessionId: first.id, userId: TEAMMATE, createdAt: at(18, 20) })
		await createUsage({
			sessionId: theirSession.id,
			taskId: theirTask.id,
			creator: TEAMMATE,
			occurredAt: at(18),
			tokens: [9000, 900, 90, 9],
			costUsd: 9,
		})

		// Nov 19, 01:00 UTC: a prompt in the scratch session that is still Nov 18 for a client 8 hours
		// west of UTC.
		await createPrompt({ sessionId: scratch.id, userId: ME, createdAt: at(19, 1) })

		// The same user id in another organization is someone else's history.
		const elsewhere = await createSession({ createdBy: ME, createdAt: at(18), orgId: otherOrganizationId })
		await createPrompt({ sessionId: elsewhere.id, userId: ME, createdAt: at(18), orgId: otherOrganizationId })
	}, 30000)

	afterAll(async () => {
		await effectRuntime?.dispose()
		await cleanupTestDb?.()
	}, 30000)

	test('lists the task I worked on, with its sessions, prompts, tokens and cost that day', async () => {
		const { rows } = await callAs(ME, { date: DAY, timezoneOffset: 0 })
		const row = rows.find((candidate) => candidate.id === ids.task)
		expect(row).toMatchObject({
			kind: 'task',
			name: 'Usage dashboard',
			archived: false,
			created: true,
			sessions: 2,
			messages: 3,
			tokens: 1200,
		})
		expect(row?.costUsd).toBeCloseTo(0.12, 10)
	})

	test('gives a session with no task its own row, under its name', async () => {
		const { rows } = await callAs(ME, { date: DAY, timezoneOffset: 0 })
		expect(rows.find((row) => row.id === ids.scratch)).toEqual({
			kind: 'session',
			id: ids.scratch,
			name: 'Scratch',
			archived: false,
			created: true,
			sessions: 1,
			messages: 1,
			tokens: null,
			costUsd: null,
		})
		// Untitled, it goes by its summary; it started last week and only spent tokens today.
		expect(rows.find((row) => row.id === ids.spendOnly)).toEqual({
			kind: 'session',
			id: ids.spendOnly,
			name: 'Background refactor',
			archived: false,
			created: false,
			sessions: 0,
			messages: 0,
			tokens: 10,
			costUsd: 0,
		})
	})

	test('keeps an archived task, tagged, and finds it through the session when the event has no task', async () => {
		const { rows } = await callAs(ME, { date: DAY, timezoneOffset: 0 })
		expect(rows.find((row) => row.id === ids.archivedTask)).toEqual({
			kind: 'task',
			id: ids.archivedTask,
			name: 'Old investigation',
			archived: true,
			created: false,
			sessions: 0,
			messages: 1,
			tokens: null,
			costUsd: null,
		})
	})

	test("ranks rows by the day's activity, highest first, and leaves out a teammate's work", async () => {
		const { rows } = await callAs(ME, { date: DAY, timezoneOffset: 0 })
		expect(rows.map((row) => row.id)).toEqual([ids.task, ids.scratch, ids.archivedTask, ids.spendOnly])
		expect(rows.map(usageDayRowActivity)).toEqual([6, 2, 1, 0])
	})

	test("adds up to the day's cell on the year grid", async () => {
		const { rows } = await callAs(ME, { date: DAY, timezoneOffset: 0 })
		const { days } = await call(
			usageYearProcedure,
			{ today: '2026-11-24', timezoneOffset: 0 },
			{ context: contextFor(ME, organizationId) },
		)
		const cell = days.find((day) => day.date === DAY)
		if (!cell?.tokens) throw new Error('expected the day to have token data')
		expect(rows.reduce((sum, row) => sum + usageDayRowActivity(row), 0)).toBe(
			cell.tasks + cell.sessions + cell.messages,
		)
		expect(rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0)).toBe(
			cell.tokens.cacheRead + cell.tokens.cacheWrite + cell.tokens.input + cell.tokens.output,
		)
		expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(cell.costUsd ?? 0, 10)
	})

	test("buckets by the client's local day", async () => {
		const west = await callAs(ME, { date: DAY, timezoneOffset: 480 })
		// UTC-8: the 01:00 UTC prompt on Nov 19 was sent on the evening of Nov 18 ...
		expect(west.rows.find((row) => row.id === ids.scratch)?.messages).toBe(2)
		// ... and the early prompt in the archived task, 05:00 UTC, was still Nov 17.
		expect(west.rows.find((row) => row.id === ids.archivedTask)).toBeUndefined()
	})

	test('returns no rows for a day with nothing on it', async () => {
		expect(await callAs(ME, { date: '2026-11-16', timezoneOffset: 0 })).toEqual({ rows: [] })
	})

	test("reads only the calling organization, and only the caller's rows", async () => {
		const elsewhere = await callAs(ME, { date: DAY, timezoneOffset: 0 }, otherOrganizationId)
		expect(elsewhere.rows).toHaveLength(1)
		expect(elsewhere.rows[0]).toMatchObject({ kind: 'session', created: true, sessions: 1, messages: 1 })

		const theirs = await callAs(TEAMMATE, { date: DAY, timezoneOffset: 0 })
		expect(theirs.rows).toHaveLength(2)
		// Their own task, and the prompt they sent in my task's session, which lands on my task.
		expect(theirs.rows[0]).toMatchObject({ name: 'Their task', created: true, sessions: 1, tokens: 9999 })
		expect(theirs.rows[1]).toMatchObject({ id: ids.task, created: false, sessions: 0, messages: 1, tokens: null })
	})

	test('refuses a date that is not a calendar day', async () => {
		await expect(callAs(ME, { date: '2026-02-30', timezoneOffset: 0 })).rejects.toThrow()
	})
})
