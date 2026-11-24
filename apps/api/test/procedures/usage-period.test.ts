import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import type { UsagePeriod } from '@devflow/api-contract/api/usage/windows'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { sessionUsageEvents } from '@devflow/db/tables/session-usage-events'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { call } from '@orpc/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { usagePeriodProcedure as liveUsagePeriodProcedure } from '../../src/orpc/api/usage/period.effect'
import { usageYearProcedure as liveUsageYearProcedure } from '../../src/orpc/api/usage/year.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/** A Tuesday. Week: Nov 23–24 vs Nov 16–17. Month: Nov 1–24 vs Oct 1–24. Year: Dec 1, 2025 on vs the 12 months before. */
const TODAY = '2026-11-24'
/** An instant on a fixture day, 15:00 UTC by default: the same local day at offset 0 and at UTC-8. */
const at = (day: string, hourUtc = 15) => BigInt(Date.parse(`${day}T${String(hourUtc).padStart(2, '0')}:00:00Z`))

describe('usage/period', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let effectRuntime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let usagePeriodProcedure: typeof liveUsagePeriodProcedure
	let usageYearProcedure: typeof liveUsageYearProcedure
	let organizationId: string
	let otherOrganizationId: string
	const hostId = randomUUID()

	const ME = `user_usage_me_${randomUUID()}`
	const TEAMMATE = `user_usage_teammate_${randomUUID()}`

	const contextFor = (userId: string, orgId: string) =>
		createMockApiContext({
			auth: createMockApiAuth({ userId, organizationId: orgId }),
			services: { db, dbReadReplica: db },
		})

	const callAs = (userId: string, period: UsagePeriod, timezoneOffset = 0, orgId = organizationId) =>
		call(usagePeriodProcedure, { period, today: TODAY, timezoneOffset }, { context: contextFor(userId, orgId) })

	const createTask = async (values: { createdBy: string; createdAt: bigint; name?: string; archived?: boolean }) => {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: values.name ?? `usage period task ${randomUUID()}`,
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
				created_at: values.createdAt,
				updated_at: values.createdAt,
			})
			.returning()
		if (!session) throw new Error('Unable to insert session for setup')
		return session
	}

	const createPrompt = async (values: { sessionId: string; userId: string; createdAt: bigint; orgId?: string }) => {
		await db.insert(conversationEvents).values({
			organization_id: values.orgId ?? organizationId,
			session_id: values.sessionId,
			resource_owner_user_id: values.userId,
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
		cacheRead: number
		cacheWrite: number
		input: number
		output: number
		costUsd: number | null
		model?: string
		orgId?: string
	}) => {
		await db.insert(sessionUsageEvents).values({
			session_id: values.sessionId,
			organization_id: values.orgId ?? organizationId,
			resource_owner_user_id: values.creator,
			session_creator_user_id: values.creator,
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

	beforeAll(async () => {
		const testDb = await createTestDb('usage_period')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		effectRuntime = createRuntimeWithTestPostgresLayer(db)
		usagePeriodProcedure = bindProcedureToRuntime(liveUsagePeriodProcedure, effectRuntime)
		usageYearProcedure = bindProcedureToRuntime(liveUsageYearProcedure, effectRuntime)

		const [org] = await db
			.insert(organizations)
			.values({ name: 'Usage Period Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		const [otherOrg] = await db
			.insert(organizations)
			.values({ name: 'Other Usage Period Org', workos_organization_id: `workos-org-${randomUUID()}` })
			.returning()
		if (!org || !otherOrg) throw new Error('Unable to insert organizations for setup')
		organizationId = org.id
		otherOrganizationId = otherOrg.id

		// Wed Nov 18: a task, its session and two prompts of mine; the Opus run cost $0.12 for 1,200 tokens.
		const task = await createTask({ createdBy: ME, createdAt: at('2026-11-18'), name: 'Mid-November task' })
		const session = await createSession({ createdBy: ME, createdAt: at('2026-11-18'), taskId: task.id })
		await createPrompt({ sessionId: session.id, userId: ME, createdAt: at('2026-11-18', 16) })
		await createPrompt({ sessionId: session.id, userId: ME, createdAt: at('2026-11-18', 17) })
		await createUsage({
			sessionId: session.id,
			creator: ME,
			occurredAt: at('2026-11-18', 17),
			cacheRead: 600,
			cacheWrite: 100,
			input: 400,
			output: 100,
			costUsd: 0.12,
		})
		// A teammate's work the same day, including a prompt in my session: never mine.
		const theirTask = await createTask({ createdBy: TEAMMATE, createdAt: at('2026-11-18') })
		const theirSession = await createSession({
			createdBy: TEAMMATE,
			createdAt: at('2026-11-18'),
			taskId: theirTask.id,
		})
		await createPrompt({ sessionId: session.id, userId: TEAMMATE, createdAt: at('2026-11-18', 18) })
		await createUsage({
			sessionId: theirSession.id,
			creator: TEAMMATE,
			occurredAt: at('2026-11-18'),
			cacheRead: 9000,
			cacheWrite: 900,
			input: 90,
			output: 9,
			costUsd: 9,
		})

		// Mon Nov 23, this week: a Codex session and a prompt. Codex records no usage.
		const codex = await createSession({ createdBy: ME, createdAt: at('2026-11-23'), codingAgent: 'codelayer' })
		await createPrompt({ sessionId: codex.id, userId: ME, createdAt: at('2026-11-23', 16) })

		// Mon Nov 16, last week: a session with no task whose Sonnet run cost $0.05.
		const lastWeek = await createSession({ createdBy: ME, createdAt: at('2026-11-16') })
		await createUsage({
			sessionId: lastWeek.id,
			creator: ME,
			occurredAt: at('2026-11-16'),
			model: 'claude-sonnet-4-6',
			cacheRead: 10,
			cacheWrite: 0,
			input: 5,
			output: 5,
			costUsd: 0.05,
		})

		// Sun Nov 1, 05:00 UTC: a session that, 8 hours west of UTC, was started on Oct 31.
		await createSession({ createdBy: ME, createdAt: at('2026-11-01', 5) })

		// Sat Oct 10, inside last month's Oct 1–24: a follow-up session whose Haiku run cost $0.30, in an
		// archived task created long before any window opens, so the task adds no activity of its own.
		const oldTask = await createTask({
			createdBy: ME,
			createdAt: at('2024-06-01'),
			name: 'Archived spring task',
			archived: true,
		})
		const lastMonth = await createSession({ createdBy: ME, createdAt: at('2026-10-10'), taskId: oldTask.id })
		await createUsage({
			sessionId: lastMonth.id,
			creator: ME,
			occurredAt: at('2026-10-10'),
			model: 'claude-haiku-4-5',
			cacheRead: 100,
			cacheWrite: 0,
			input: 50,
			output: 50,
			costUsd: 0.3,
		})
		// Oct 28: last month, but after the day of the month it is today, so not in the comparison.
		await createSession({ createdBy: ME, createdAt: at('2026-10-28') })

		// Thu Nov 20, 2025: inside the previous twelve months (Dec 1, 2024 – Nov 24, 2025).
		await createTask({ createdBy: ME, createdAt: at('2025-11-20') })
		// Nov 28, 2025: after the previous year's cut-off and before the current year opens on Dec 1.
		await createTask({ createdBy: ME, createdAt: at('2025-11-28') })
		// Nov 30, 2024: before the previous year opens.
		await createTask({ createdBy: ME, createdAt: at('2024-11-30') })

		// Nov 20 in another organization: someone else's history, under the same user id.
		const elsewhere = await createSession({
			createdBy: ME,
			createdAt: at('2026-11-20'),
			orgId: otherOrganizationId,
		})
		await createUsage({
			sessionId: elsewhere.id,
			creator: ME,
			occurredAt: at('2026-11-20'),
			orgId: otherOrganizationId,
			cacheRead: 1,
			cacheWrite: 1,
			input: 1,
			output: 1,
			costUsd: 1,
		})
	}, 30000)

	afterAll(async () => {
		await effectRuntime?.dispose()
		await cleanupTestDb?.()
	}, 30000)

	test('compares this week so far with the same days last week', async () => {
		const { current, previous } = await callAs(ME, 'week')
		expect(current).toEqual({
			tasks: 0,
			sessions: 1,
			messages: 1,
			// The Codex week recorded nothing: no data, not $0.00.
			tokens: null,
			costUsd: null,
			activeDays: 1,
			elapsedDays: 2,
			topWeekday: 0,
		})
		expect(previous).toEqual({
			tasks: 0,
			sessions: 1,
			messages: 0,
			tokens: { cacheRead: 10, cacheWrite: 0, input: 5, output: 5 },
			costUsd: 0.05,
			activeDays: 1,
			elapsedDays: 2,
			topWeekday: 0,
		})
	})

	test('compares this month so far with last month up to the same day', async () => {
		const { current, previous } = await callAs(ME, 'month')
		expect(current).toMatchObject({
			tasks: 1,
			// Nov 1, 16, 18 and 23.
			sessions: 4,
			messages: 3,
			tokens: { cacheRead: 610, cacheWrite: 100, input: 405, output: 105 },
			activeDays: 4,
			elapsedDays: 24,
			// Wednesday's four activities beat Monday's three.
			topWeekday: 2,
		})
		expect(current.costUsd).toBeCloseTo(0.17, 10)
		// Oct 28 is past the 24th, so only Oct 10 is compared.
		expect(previous).toEqual({
			tasks: 0,
			sessions: 1,
			messages: 0,
			tokens: { cacheRead: 100, cacheWrite: 0, input: 50, output: 50 },
			costUsd: 0.3,
			activeDays: 1,
			elapsedDays: 24,
			topWeekday: 5,
		})
	})

	test('compares the last twelve months with the twelve before them', async () => {
		const { current, previous } = await callAs(ME, 'year')
		expect(current).toMatchObject({
			tasks: 1,
			// Every 2026 session: Oct 10, Oct 28, Nov 1, 16, 18 and 23.
			sessions: 6,
			messages: 3,
			tokens: { cacheRead: 710, cacheWrite: 100, input: 455, output: 155 },
			activeDays: 6,
			// Dec 1, 2025 through Nov 24, 2026.
			elapsedDays: 359,
			topWeekday: 2,
		})
		expect(current.costUsd).toBeCloseTo(0.47, 10)
		// Only Nov 20, 2025: Nov 28, 2025 falls between the windows, Nov 30, 2024 before them.
		expect(previous).toEqual({
			tasks: 1,
			sessions: 0,
			messages: 0,
			tokens: null,
			costUsd: null,
			activeDays: 1,
			elapsedDays: 359,
			topWeekday: 3,
		})
	})

	test("adds up to the year grid's cells over the same days", async () => {
		const { current } = await callAs(ME, 'month')
		const { days } = await call(
			usageYearProcedure,
			{ today: TODAY, timezoneOffset: 0 },
			{ context: contextFor(ME, organizationId) },
		)
		const month = days.filter((day) => day.date >= '2026-11-01')
		expect(current.tasks).toBe(month.reduce((sum, day) => sum + day.tasks, 0))
		expect(current.sessions).toBe(month.reduce((sum, day) => sum + day.sessions, 0))
		expect(current.messages).toBe(month.reduce((sum, day) => sum + day.messages, 0))
		expect(current.costUsd).toBeCloseTo(
			month.reduce((sum, day) => sum + (day.costUsd ?? 0), 0),
			10,
		)
	})

	test("buckets by the client's local day", async () => {
		// UTC-8: the Nov 1, 05:00 UTC session was started on Oct 31, outside both month windows.
		const { current, previous } = await callAs(ME, 'month', 480)
		expect(current).toMatchObject({ sessions: 3, activeDays: 3 })
		expect(previous).toMatchObject({ sessions: 1, activeDays: 1 })
	})

	test("leaves out a teammate's work, and reads only the calling organization", async () => {
		const theirs = await callAs(TEAMMATE, 'month')
		expect(theirs.current).toMatchObject({
			tasks: 1,
			sessions: 1,
			messages: 1,
			tokens: { cacheRead: 9000, cacheWrite: 900, input: 90, output: 9 },
			costUsd: 9,
			activeDays: 1,
		})

		const elsewhere = await callAs(ME, 'month', 0, otherOrganizationId)
		expect(elsewhere.current).toMatchObject({
			tasks: 0,
			sessions: 1,
			messages: 0,
			tokens: { cacheRead: 1, cacheWrite: 1, input: 1, output: 1 },
			costUsd: 1,
		})
		expect(elsewhere.previous).toMatchObject({ sessions: 0, tokens: null, costUsd: null })
	})

	test('splits the month into a bar per day, the future ones empty, and ranks models and tasks', async () => {
		const { buckets, byModel, topTasks } = await callAs(ME, 'month')
		// Every day of November, the 25th–30th still to come.
		expect(buckets.map((bucket) => bucket.start)).toEqual(
			Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`),
		)
		const spent = buckets.filter((bucket) => Object.keys(bucket.costByModel).length > 0)
		expect(spent).toEqual([
			{ start: '2026-11-16', costByModel: { 'claude-sonnet-4-6': 0.05 } },
			{ start: '2026-11-18', costByModel: { 'claude-opus-4-5': 0.12 } },
		])
		expect(byModel).toEqual([
			{ model: 'claude-opus-4-5', costUsd: 0.12 },
			{ model: 'claude-sonnet-4-6', costUsd: 0.05 },
		])
		// The Nov 16 session has no task, so only the Nov 18 task is listed; the teammate's $9 isn't mine.
		expect(topTasks).toEqual([
			{ taskId: expect.any(String), name: 'Mid-November task', archived: false, tokens: 1200, costUsd: 0.12 },
		])
	})

	test('splits the year into a bar per month and tags an archived task', async () => {
		const { buckets, byModel, topTasks } = await callAs(ME, 'year')
		expect(buckets).toHaveLength(12)
		expect(buckets[0]).toEqual({ start: '2025-12-01', costByModel: {} })
		expect(buckets.at(-2)).toEqual({ start: '2026-10-01', costByModel: { 'claude-haiku-4-5': 0.3 } })
		expect(buckets.at(-1)).toEqual({
			start: '2026-11-01',
			costByModel: { 'claude-opus-4-5': 0.12, 'claude-sonnet-4-6': 0.05 },
		})
		expect(byModel.map((row) => row.model)).toEqual(['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-6'])
		// The archived task's follow-up session outspent this month's task; archiving rewrites no history.
		expect(topTasks).toEqual([
			{ taskId: expect.any(String), name: 'Archived spring task', archived: true, tokens: 200, costUsd: 0.3 },
			{ taskId: expect.any(String), name: 'Mid-November task', archived: false, tokens: 1200, costUsd: 0.12 },
		])
	})

	test('has seven empty bars, and nothing to rank, for a week with no recorded usage', async () => {
		const { buckets, byModel, topTasks } = await callAs(ME, 'week')
		expect(buckets).toEqual(
			['23', '24', '25', '26', '27', '28', '29'].map((day) => ({ start: `2026-11-${day}`, costByModel: {} })),
		)
		expect(byModel).toEqual([])
		expect(topTasks).toEqual([])
	})

	test("adds up the chart's bars to the period's cost", async () => {
		const { current, buckets, byModel } = await callAs(ME, 'year')
		const barTotal = buckets.reduce(
			(sum, bucket) => sum + Object.values(bucket.costByModel).reduce((a, b) => a + b, 0),
			0,
		)
		expect(barTotal).toBeCloseTo(current.costUsd ?? Number.NaN, 10)
		expect(byModel.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(barTotal, 10)
	})

	test('rejects a period it does not know', async () => {
		await expect(
			call(
				usagePeriodProcedure,
				// @ts-expect-error: not a period
				{ period: 'day', today: TODAY, timezoneOffset: 0 },
				{ context: contextFor(ME, organizationId) },
			),
		).rejects.toThrow()
	})
})
