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

/**
 * One archived Claude task of the local user on {@link USAGE_DAY}: the task, one session and one prompt,
 * three activities in all, and the run's usage-ledger row ({@link USAGE_RUN}). Plus one archived Codex
 * session on {@link CODEX_DAY}, with no ledger row. Archived, so they stay out of the sidebar while the
 * spec runs, and because archiving must not rewrite history.
 */
export async function seedUsageFixture(): Promise<UsageFixture> {
	const config = JSON.parse(readFileSync(join(DEVFLOW_HOME, 'config.json'), 'utf8')) as LauncherConfig
	const client = new pg.Client({ connectionString: stackDatabaseUrl(config) })
	await client.connect()

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
