// Seeds the running stack's Postgres with a known day of the local user's activity, so the usage page
// can be checked without live model calls. Dates are fixed in 2020, before any real stack existed, and
// the spec pins the browser clock to them, so a developer's own history never shows in the grid. Every
// row is inserted with its own id and deleted by id afterwards.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { DEVFLOW_HOME } from './helpers'

/** The day the browser thinks it is, a Wednesday. */
export const USAGE_TODAY = '2020-06-17'
/** The fixture day, a week earlier. */
export const USAGE_DAY = '2020-06-10'
/** A Codex-only day: activity, but Codex never records token usage. A Friday. */
export const CODEX_DAY = '2020-06-12'

/** The Claude run on {@link USAGE_DAY}: 1,200 tokens in all, for $0.12. */
export const USAGE_RUN = {
	model: 'claude-opus-4-5',
	cacheRead: 600,
	cacheWrite: 100,
	input: 400,
	output: 100,
	costUsd: 0.12,
}

/** The launcher's own constants (apps/launcher/src/devflow.ts): ports shift with `--port`. */
const BASE_HTTPS_PORT = 47443
const BASE_POSTGRES_PORT = 47432

type LauncherConfig = { organizationId: string; userId: string; postgresPassword: string; httpsPort?: number }

function stackDatabaseUrl(config: LauncherConfig): string {
	const port = BASE_POSTGRES_PORT + (config.httpsPort ?? BASE_HTTPS_PORT) - BASE_HTTPS_PORT
	return `postgresql://postgres:${encodeURIComponent(config.postgresPassword)}@127.0.0.1:${port}/electric`
}

export type UsageFixture = { taskName: string; cleanup: () => Promise<void> }

async function connectToStack(): Promise<{ config: LauncherConfig; client: pg.Client }> {
	const config = JSON.parse(readFileSync(join(DEVFLOW_HOME, 'config.json'), 'utf8')) as LauncherConfig
	const client = new pg.Client({ connectionString: stackDatabaseUrl(config) })
	await client.connect()
	return { config, client }
}

/**
 * One archived Claude task of the local user on {@link USAGE_DAY}: the task, one session and one prompt,
 * three activities in all, and the run's usage-ledger row ({@link USAGE_RUN}). Plus one archived Codex
 * session on {@link CODEX_DAY}, with no ledger row. Archived, so they stay out of the sidebar while the
 * spec runs, and because archiving must not rewrite history.
 */
export async function seedUsageFixture(): Promise<UsageFixture> {
	const { config, client } = await connectToStack()

	const at = Date.parse(`${USAGE_DAY}T15:00:00Z`)
	const taskId = randomUUID()
	const sessionId = randomUUID()
	const eventId = randomUUID()
	const usageId = randomUUID()
	const codexSessionId = randomUUID()
	const codexAt = Date.parse(`${CODEX_DAY}T15:00:00Z`)
	const taskName = `Usage e2e fixture ${taskId.slice(0, 8)}`
	const { organizationId, userId } = config

	try {
		await client.query('BEGIN')
		await client.query(
			`INSERT INTO tasks (id, organization_id, name, created_by, resource_owner_user_id, archived, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $4, true, $5, $5)`,
			[taskId, organizationId, taskName, userId, at],
		)
		// The badge's aggregates carry the same run as the ledger row below.
		await client.query(
			`INSERT INTO sessions (id, organization_id, task_id, created_by, resource_owner_user_id, host_id, working_directory,
				coding_agent, status, archived, title, total_cost_usd, model_usage, created_at, updated_at, last_activity_at)
			 VALUES ($1, $2, $3, $4, $4, 'usage-e2e-fixture', '/tmp', 'claude', 'ready_for_input', true, $5, $6, $7, $8, $8, $8)`,
			[
				sessionId,
				organizationId,
				taskId,
				userId,
				taskName,
				USAGE_RUN.costUsd,
				JSON.stringify({
					[USAGE_RUN.model]: {
						input_tokens: USAGE_RUN.input,
						output_tokens: USAGE_RUN.output,
						cache_read_input_tokens: USAGE_RUN.cacheRead,
						cache_creation_input_tokens: USAGE_RUN.cacheWrite,
					},
				}),
				at,
			],
		)
		await client.query(
			`INSERT INTO conversation_events (id, organization_id, session_id, task_id, resource_owner_user_id, user_id,
				event_type, role, content, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $5, 'message', 'user', 'Seeded usage prompt', $6, $6)`,
			[eventId, organizationId, sessionId, taskId, userId, at + 60_000],
		)
		await client.query(
			`INSERT INTO session_usage_events (id, session_id, organization_id, resource_owner_user_id, session_creator_user_id,
				task_id, coding_agent, source, report_key, model, tokens, input_tokens, output_tokens, cache_read_tokens,
				cache_creation_tokens, cost_usd, occurred_at)
			 VALUES ($1, $2, $3, $4, $4, $5, 'claude', 'claude_sdk_result', $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
			[
				usageId,
				sessionId,
				organizationId,
				userId,
				taskId,
				`usage-e2e-${usageId}`,
				USAGE_RUN.model,
				JSON.stringify({
					input_tokens: USAGE_RUN.input,
					output_tokens: USAGE_RUN.output,
					cache_read_input_tokens: USAGE_RUN.cacheRead,
					cache_creation_input_tokens: USAGE_RUN.cacheWrite,
				}),
				USAGE_RUN.input,
				USAGE_RUN.output,
				USAGE_RUN.cacheRead,
				USAGE_RUN.cacheWrite,
				USAGE_RUN.costUsd,
				at + 120_000,
			],
		)
		await client.query(
			`INSERT INTO sessions (id, organization_id, created_by, resource_owner_user_id, host_id, working_directory,
				coding_agent, status, archived, title, created_at, updated_at, last_activity_at)
			 VALUES ($1, $2, $3, $3, 'usage-e2e-fixture', '/tmp', 'codelayer', 'ready_for_input', true, $4, $5, $5, $5)`,
			[codexSessionId, organizationId, userId, `Usage e2e Codex fixture ${codexSessionId.slice(0, 8)}`, codexAt],
		)
		await client.query('COMMIT')
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined)
		await client.end()
		throw error
	}

	return {
		taskName,
		cleanup: async () => {
			try {
				await client.query('DELETE FROM session_usage_events WHERE id = $1', [usageId])
				await client.query('DELETE FROM conversation_events WHERE id = $1', [eventId])
				await client.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [[sessionId, codexSessionId]])
				await client.query('DELETE FROM tasks WHERE id = $1', [taskId])
			} finally {
				await client.end()
			}
		},
	}
}

// ── A year of history ────────────────────────────────────────────────────────

/**
 * The day the browser thinks it is for the year-sized seed, a Wednesday in 2017: three years before
 * {@link USAGE_TODAY}, so neither seed shows in the other's grid, periods or comparisons.
 */
export const YEAR_TODAY = '2017-06-14'
/** The Monday 52 weeks back that opens {@link YEAR_TODAY}'s grid; the seed fills every day from here. */
export const YEAR_FROM = '2016-06-13'

/** What the year seed puts on every day. */
export const YEAR_PER_DAY = {
	tasks: 1,
	sessionsPerTask: 2,
	promptsPerSession: 4,
	/** Assistant replies, tool calls and tool results: daemon-written events the message count must skip. */
	daemonEventsPerSession: 12,
}

const DAY_MS = 86_400_000

/** Every day of the seeded year, {@link YEAR_FROM} to {@link YEAR_TODAY} inclusive. */
export const YEAR_DAYS = (Date.parse(`${YEAR_TODAY}T00:00:00Z`) - Date.parse(`${YEAR_FROM}T00:00:00Z`)) / DAY_MS + 1

/** The headline's count: every seeded task, session and prompt. */
export const YEAR_ACTIVITIES =
	YEAR_DAYS * YEAR_PER_DAY.tasks * (1 + YEAR_PER_DAY.sessionsPerTask * (1 + YEAR_PER_DAY.promptsPerSession))

export type YearFixture = {
	/** `EXPLAIN ANALYZE` of the usage page's message count over the seeded year, as plan text. */
	explainMessages: () => Promise<string>
	cleanup: () => Promise<void>
}

/**
 * A full year of the local user's history ending on {@link YEAR_TODAY}, every day busy: tasks, Claude
 * sessions, prompts with the daemon's own events around them, and a ledger row per session alternating
 * Opus and Sonnet. All archived, so the sidebar stays as it was. Rows are generated in SQL and deleted
 * by id afterwards; the tables are analyzed so the planner sees the seed the way it would see real
 * history.
 */
export async function seedYear(): Promise<YearFixture> {
	const { config, client } = await connectToStack()
	const { organizationId, userId } = config
	const tag = randomUUID().slice(0, 8)
	// Noon UTC: the spec pins the browser to UTC, so every row lands on the day it was generated for.
	const firstNoon = Date.parse(`${YEAR_FROM}T12:00:00Z`)
	let taskIds: string[] = []
	let sessionIds: string[] = []

	const cleanup = async () => {
		try {
			// Events and ledger rows also cascade from their sessions; deleting them first keeps it explicit.
			await client.query('DELETE FROM session_usage_events WHERE session_id = ANY($1::uuid[])', [sessionIds])
			await client.query('DELETE FROM conversation_events WHERE session_id = ANY($1::uuid[])', [sessionIds])
			await client.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [sessionIds])
			await client.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds])
		} finally {
			await client.end()
		}
	}

	try {
		await client.query('BEGIN')
		const tasks = await client.query<{ id: string }>(
			`INSERT INTO tasks (id, organization_id, name, created_by, resource_owner_user_id, archived, created_at, updated_at)
			 SELECT gen_random_uuid(), $1, 'Usage e2e year ' || $2::text || ' #' || (d * $3 + n), $4, $4, true,
				$5::bigint + d::bigint * ${DAY_MS} + n * 60000, $5::bigint + d::bigint * ${DAY_MS} + n * 60000
			 FROM generate_series(0, $6 - 1) d CROSS JOIN generate_series(0, $3 - 1) n
			 RETURNING id`,
			[organizationId, tag, YEAR_PER_DAY.tasks, userId, firstNoon, YEAR_DAYS],
		)
		taskIds = tasks.rows.map((row) => row.id)
		const sessions = await client.query<{ id: string }>(
			`INSERT INTO sessions (id, organization_id, task_id, created_by, resource_owner_user_id, host_id, working_directory,
				coding_agent, status, archived, title, created_at, updated_at, last_activity_at)
			 SELECT gen_random_uuid(), t.organization_id, t.id, $2, $2, $3, '/tmp', 'claude', 'ready_for_input', true,
				t.name || ' session ' || n, t.created_at + n * 3600000, t.created_at + n * 3600000, t.created_at + n * 3600000
			 FROM tasks t CROSS JOIN generate_series(0, $4 - 1) n
			 WHERE t.id = ANY($1::uuid[])
			 RETURNING id`,
			[taskIds, userId, `usage-e2e-year-${tag}`, YEAR_PER_DAY.sessionsPerTask],
		)
		sessionIds = sessions.rows.map((row) => row.id)
		// The user's prompts, a minute apart after each session starts.
		await client.query(
			`INSERT INTO conversation_events (organization_id, session_id, task_id, resource_owner_user_id, user_id,
				event_type, role, content, created_at, updated_at)
			 SELECT s.organization_id, s.id, s.task_id, $2, $2, 'message', 'user', 'Seeded prompt ' || m,
				s.created_at + m * 60000, s.created_at + m * 60000
			 FROM sessions s CROSS JOIN generate_series(1, $3) m
			 WHERE s.id = ANY($1::uuid[])`,
			[sessionIds, userId, YEAR_PER_DAY.promptsPerSession],
		)
		// What the daemon writes around them: no user_id, and only some with role 'message'.
		await client.query(
			`INSERT INTO conversation_events (organization_id, session_id, task_id, resource_owner_user_id, user_id,
				event_type, role, content, created_at, updated_at)
			 SELECT s.organization_id, s.id, s.task_id, $2, NULL,
				(ARRAY['message', 'tool_call', 'tool_result'])[k % 3 + 1],
				(ARRAY['assistant', 'assistant', 'user'])[k % 3 + 1],
				'Seeded daemon event ' || k, s.created_at + k * 15000, s.created_at + k * 15000
			 FROM sessions s CROSS JOIN generate_series(1, $3) k
			 WHERE s.id = ANY($1::uuid[])`,
			[sessionIds, userId, YEAR_PER_DAY.daemonEventsPerSession],
		)
		await client.query(
			`INSERT INTO session_usage_events (session_id, organization_id, resource_owner_user_id, session_creator_user_id,
				task_id, coding_agent, source, report_key, model, tokens, input_tokens, output_tokens, cache_read_tokens,
				cache_creation_tokens, cost_usd, occurred_at)
			 SELECT s.id, s.organization_id, $2, $2, s.task_id, 'claude', 'claude_sdk_result', 'usage-e2e-year-' || s.id,
				-- A task's sessions start an hour apart, so every day spends on both models.
				CASE WHEN (s.created_at / 3600000) % 2 = 0 THEN 'claude-opus-4-5' ELSE 'claude-sonnet-4-5' END,
				'{"input_tokens":400,"output_tokens":600,"cache_read_input_tokens":6000,"cache_creation_input_tokens":1000}'::jsonb,
				400, 600, 6000, 1000, 0.25, s.created_at + 30 * 60000
			 FROM sessions s
			 WHERE s.id = ANY($1::uuid[])`,
			[sessionIds, userId],
		)
		await client.query('COMMIT')
		// Fresh statistics, as autovacuum would eventually gather, so the plan reflects the seeded volume.
		await client.query('ANALYZE tasks, sessions, conversation_events, session_usage_events')
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined)
		await cleanup().catch(() => undefined)
		throw error
	}

	return {
		// The message branch of the server's `myActivityEvents` (apps/api/src/orpc/api/usage/usage-sql.ts),
		// over the same window the grid asks for. `role` and `event_type` stay literals, as there, so the
		// planner can match the partial index's predicate.
		explainMessages: async () => {
			const plan = await client.query<{ 'QUERY PLAN': string }>(
				`EXPLAIN (ANALYZE, COSTS OFF)
				 SELECT ce.created_at, ce.task_id, ce.session_id
				 FROM conversation_events ce
				 JOIN sessions es ON es.id = ce.session_id
				 WHERE ce.organization_id = $1
					AND ce.user_id = $2
					AND ce.role = 'user'
					AND ce.event_type = 'message'
					AND ce.created_at BETWEEN $3 AND $4
					AND NOT (es.forked_from_session_id IS NOT NULL AND ce.created_at < es.created_at)`,
				[
					organizationId,
					userId,
					Date.parse(`${YEAR_FROM}T00:00:00Z`),
					Date.parse(`${YEAR_TODAY}T00:00:00Z`) + DAY_MS - 1,
				],
			)
			return plan.rows.map((row) => row['QUERY PLAN']).join('\n')
		},
		cleanup,
	}
}
