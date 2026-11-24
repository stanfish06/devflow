import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { sessionUsageEvents } from '@devflow/db/tables/session-usage-events'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { call } from '@orpc/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { usageYearProcedure as liveUsageYearProcedure } from '../../src/orpc/api/usage/year.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/** A Tuesday. */
const TODAY = '2026-11-24'
/** 15:00 UTC on a November fixture day: the same local day at offset 0 and at UTC-8. */
const at = (day: number, hourUtc = 15) => BigInt(Date.UTC(2026, 10, day, hourUtc))

describe('usage/year', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let effectRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let usageYearProcedure: typeof liveUsageYearProcedure
	let organizationId: string
	let otherOrganizationId: string
	const hostId = randomUUID()

	const ME = `user_usage_me_${randomUUID()}`
	const TEAMMATE = `user_usage_teammate_${randomUUID()}`

	const callAs = (userId: string, input: { today: string; timezoneOffset?: number }, orgId = organizationId) =>
		call(usageYearProcedure, input, {
			context: createMockApiContext({
				auth: createMockApiAuth({ userId, organizationId: orgId }),
				services: { db, dbReadReplica: db },
			}),
		})

	const createTask = async (values: { createdBy: string; owner?: string; createdAt: bigint; isDraft?: boolean }) => {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: `usage task ${randomUUID()}`,
				created_by: values.createdBy,
				resource_owner_user_id: values.owner ?? values.createdBy,
				is_draft: values.isDraft ?? false,
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
		forkedFrom?: string
		codingAgent?: 'claude' | 'codelayer'
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
				coding_agent: values.codingAgent ?? 'claude',
				status: 'ready_for_input',
				forked_from_session_id: values.forkedFrom ?? null,
				created_at: values.createdAt,
				updated_at: values.createdAt,
			})
			.returning()
		if (!session) throw new Error('Unable to insert session for setup')
		return session
	}

	const createEvent = async (values: {
		sessionId: string
		userId: string | null
		createdAt: bigint
		role?: 'user' | 'assistant'
		eventType?: 'message' | 'tool_result'
		taskId?: string
		orgId?: string
	}) => {
		await db.insert(conversationEvents).values({
			organization_id: values.orgId ?? organizationId,
			session_id: values.sessionId,
			task_id: values.taskId ?? null,
			resource_owner_user_id: values.userId ?? ME,
			user_id: values.userId,
			role: values.role ?? 'user',
			event_type: values.eventType ?? 'message',
			content: 'hello',
			created_at: values.createdAt,
			updated_at: values.createdAt,
		})
	}

	/** One ledger row: one run of one model, as the daemon records it. */
	const createUsage = async (values: {
		sessionId: string
		creator: string
		owner?: string
		occurredAt: bigint
		model?: string
		cacheRead: number
		cacheWrite: number
		input: number
		output: number
		costUsd: number | null
		taskId?: string
		orgId?: string
	}) => {
		await db.insert(sessionUsageEvents).values({
			session_id: values.sessionId,
			organization_id: values.orgId ?? organizationId,
			resource_owner_user_id: values.owner ?? values.creator,
			session_creator_user_id: values.creator,
			task_id: values.taskId ?? null,
			coding_agent: 'claude',
			source: 'claude_sdk_result',
			report_key: `report-${randomUUID()}`,
			model: values.model ?? 'claude-opus-4-5',
			tokens: { input_tokens: values.input, output_tokens: values.output },
			input_tokens: values.input,
			output_tokens: values.output,
			cache_read_tokens: values.cacheRead,
			cache_creation_tokens: values.cacheWrite,
			cost_usd: values.costUsd,
			occurred_at: values.occurredAt,
		})
	}

	const noUsage = { tokens: null, costUsd: null }

	const dayOf = <Day extends { date: string }>(days: Day[], date: string) => days.find((day) => day.date === date)

	beforeAll(async () => {
		const testDb = await createTestDb('usage_year')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		effectRuntime = createRuntimeWithTestPostgresLayer(db)
		usageYearProcedure = bindProcedureToRuntime(liveUsageYearProcedure, effectRuntime)

		const [org] = await db
			.insert(organizations)
			.values({ name: 'Usage Year Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		const [otherOrg] = await db
			.insert(organizations)
			.values({ name: 'Other Usage Year Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		if (!org || !otherOrg) throw new Error('Unable to insert organizations for setup')
		organizationId = org.id
		otherOrganizationId = otherOrg.id

		// Nov 18: one task, one session and one prompt of mine.
		const task = await createTask({ createdBy: ME, createdAt: at(18) })
		const session = await createSession({ createdBy: ME, createdAt: at(18), taskId: task.id })
		await createEvent({ sessionId: session.id, userId: ME, createdAt: at(18, 16), taskId: task.id })
		// The daemon's own writes on the same day carry no user_id, or aren't user prompts: never counted.
		await createEvent({ sessionId: session.id, userId: null, createdAt: at(18, 16) })
		await createEvent({ sessionId: session.id, userId: ME, createdAt: at(18, 16), role: 'assistant' })
		await createEvent({ sessionId: session.id, userId: ME, createdAt: at(18, 16), eventType: 'tool_result' })
		// A draft I saved but never launched hasn't started any work.
		await createTask({ createdBy: ME, createdAt: at(18), isDraft: true })
		// The Claude run behind that prompt: two models, 600 cache-read, 100 cache-write, 400 input and
		// 100 output tokens in all, for $0.12.
		await createUsage({
			sessionId: session.id,
			taskId: task.id,
			creator: ME,
			occurredAt: at(18, 17),
			cacheRead: 500,
			cacheWrite: 100,
			input: 300,
			output: 50,
			costUsd: 0.1,
		})
		await createUsage({
			sessionId: session.id,
			taskId: task.id,
			creator: ME,
			occurredAt: at(18, 17),
			model: 'claude-haiku-4-5',
			cacheRead: 100,
			cacheWrite: 0,
			input: 100,
			output: 50,
			costUsd: 0.02,
		})

		// Nov 17: a Codex session of mine. It counts as activity, but Codex never records usage.
		await createSession({ createdBy: ME, createdAt: at(17), codingAgent: 'codelayer' })

		// Nov 19: a teammate's work in my organization, including a prompt they sent in MY session.
		const theirTask = await createTask({ createdBy: TEAMMATE, createdAt: at(19) })
		const theirSession = await createSession({ createdBy: TEAMMATE, createdAt: at(19), taskId: theirTask.id })
		await createEvent({ sessionId: session.id, userId: TEAMMATE, createdAt: at(19) })
		// Their session's run, on a task since handed to me: the tokens stay theirs.
		await createUsage({
			sessionId: theirSession.id,
			creator: TEAMMATE,
			owner: ME,
			occurredAt: at(19),
			cacheRead: 9000,
			cacheWrite: 900,
			input: 90,
			output: 9,
			costUsd: 9,
		})

		// Nov 20: ownership was reassigned both ways. Attribution follows who created the task.
		await createTask({ createdBy: ME, owner: TEAMMATE, createdAt: at(20) })
		await createTask({ createdBy: TEAMMATE, owner: ME, createdAt: at(20) })

		// Nov 21: I forked my Nov 18 session. The fork is a new session of mine, and the parent's prompt
		// copied into it (original sender and time) must not count a second time. A prompt I send in
		// the fork afterwards does count.
		const fork = await createSession({ createdBy: ME, createdAt: at(21), forkedFrom: session.id })
		await createEvent({ sessionId: fork.id, userId: ME, createdAt: at(18, 16) })
		await createEvent({ sessionId: fork.id, userId: ME, createdAt: at(21, 16) })

		// Nov 22, 01:00 UTC: a prompt that is still Nov 21 for a client 8 hours west of UTC.
		await createEvent({ sessionId: session.id, userId: ME, createdAt: at(22, 1) })

		// Nov 23: the same user id in another organization is someone else's history.
		const elsewhere = await createSession({ createdBy: ME, createdAt: at(23), orgId: otherOrganizationId })
		await createEvent({ sessionId: elsewhere.id, userId: ME, createdAt: at(23), orgId: otherOrganizationId })
		await createUsage({
			sessionId: elsewhere.id,
			creator: ME,
			occurredAt: at(23),
			orgId: otherOrganizationId,
			cacheRead: 1,
			cacheWrite: 1,
			input: 1,
			output: 1,
			costUsd: 1,
		})

		// Today, 10:00 UTC: my Nov 18 session ran again. Usage lands on the day it was spent, even with
		// no activity of mine that day. The SDK gave no cost for this run.
		await createUsage({
			sessionId: session.id,
			taskId: task.id,
			creator: ME,
			occurredAt: at(24, 10),
			cacheRead: 0,
			cacheWrite: 0,
			input: 7,
			output: 3,
			costUsd: null,
		})

		// Before the window: never read.
		await createTask({ createdBy: ME, createdAt: BigInt(Date.UTC(2025, 10, 23, 15)) })
	}, 30000)

	afterAll(async () => {
		await effectRuntime?.dispose()
		await cleanupTestDb?.()
	}, 30000)

	test('returns one entry per day of the 52-week window, ending today', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		const window = yearWindow(TODAY)
		expect(days[0]?.date).toBe(window.from)
		expect(days.at(-1)?.date).toBe(TODAY)
		// 52 whole weeks, then Monday and Tuesday of this one.
		expect(days).toHaveLength(52 * 7 + 2)
		// The task created the day before the window opened is not in it.
		expect(dayOf(days, window.from)).toEqual({ date: window.from, tasks: 0, sessions: 0, messages: 0, ...noUsage })
	})

	test('counts my tasks, sessions and prompts per day, and nothing the daemon wrote', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(days, '2026-11-18')).toMatchObject({ date: '2026-11-18', tasks: 1, sessions: 1, messages: 1 })
	})

	test("sums my sessions' tokens and cost per day, across models", async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		const day = dayOf(days, '2026-11-18')
		expect(day?.tokens).toEqual({ cacheRead: 600, cacheWrite: 100, input: 400, output: 100 })
		expect(day?.costUsd).toBeCloseTo(0.12, 10)
		// The ledger side is summed per day before the join: two ledger rows don't double the activity.
		expect(day).toMatchObject({ tasks: 1, sessions: 1, messages: 1 })
	})

	test('reports no token data, not zero, for a day without ledger rows', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		// The Codex-only day: activity, but nothing recorded.
		expect(dayOf(days, '2026-11-17')).toEqual({
			date: '2026-11-17',
			tasks: 0,
			sessions: 1,
			messages: 0,
			...noUsage,
		})
		// A day with neither.
		expect(dayOf(days, '2026-11-16')).toEqual({
			date: '2026-11-16',
			tasks: 0,
			sessions: 0,
			messages: 0,
			...noUsage,
		})
	})

	test('puts usage on the day it was spent, even without activity that day', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(days, TODAY)).toEqual({
			date: TODAY,
			tasks: 0,
			sessions: 0,
			messages: 0,
			tokens: { cacheRead: 0, cacheWrite: 0, input: 7, output: 3 },
			// Rows exist, so a run the SDK didn't price is $0, not "No token data recorded".
			costUsd: 0,
		})
	})

	test("leaves out a teammate's work, even in my own session", async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(days, '2026-11-19')).toEqual({
			date: '2026-11-19',
			tasks: 0,
			sessions: 0,
			messages: 0,
			...noUsage,
		})

		const theirs = await callAs(TEAMMATE, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(theirs.days, '2026-11-19')).toEqual({
			date: '2026-11-19',
			tasks: 1,
			sessions: 1,
			messages: 1,
			tokens: { cacheRead: 9000, cacheWrite: 900, input: 90, output: 9 },
			costUsd: 9,
		})
	})

	test('attributes a reassigned task to whoever created it', async () => {
		const mine = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(mine.days, '2026-11-20')?.tasks).toBe(1)
		const theirs = await callAs(TEAMMATE, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(theirs.days, '2026-11-20')?.tasks).toBe(1)
	})

	test('counts a fork as a session but not the prompts it copied from its parent', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(days, '2026-11-21')).toEqual({
			date: '2026-11-21',
			tasks: 0,
			sessions: 1,
			messages: 1,
			...noUsage,
		})
		// The copied prompt kept its Nov 18 time; that day still counts the original once.
		expect(dayOf(days, '2026-11-18')?.messages).toBe(1)
	})

	test("buckets by the client's local day", async () => {
		const utc = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(utc.days, '2026-11-22')?.messages).toBe(1)
		expect(dayOf(utc.days, '2026-11-21')?.messages).toBe(1)

		// UTC-8: the 01:00 UTC prompt on Nov 22 happened on the evening of Nov 21.
		const west = await callAs(ME, { today: TODAY, timezoneOffset: 480 })
		expect(dayOf(west.days, '2026-11-22')?.messages).toBe(0)
		expect(dayOf(west.days, '2026-11-21')?.messages).toBe(2)
	})

	test('reads only the calling organization', async () => {
		const { days } = await callAs(ME, { today: TODAY, timezoneOffset: 0 })
		expect(dayOf(days, '2026-11-23')).toEqual({
			date: '2026-11-23',
			tasks: 0,
			sessions: 0,
			messages: 0,
			...noUsage,
		})

		const elsewhere = await callAs(ME, { today: TODAY, timezoneOffset: 0 }, otherOrganizationId)
		expect(dayOf(elsewhere.days, '2026-11-23')).toEqual({
			date: '2026-11-23',
			tasks: 0,
			sessions: 1,
			messages: 1,
			tokens: { cacheRead: 1, cacheWrite: 1, input: 1, output: 1 },
			costUsd: 1,
		})
		expect(elsewhere.days.reduce((sum, day) => sum + day.tasks + day.sessions + day.messages, 0)).toBe(2)
	})
})
