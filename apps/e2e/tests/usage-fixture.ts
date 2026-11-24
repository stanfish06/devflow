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
 * three activities in all. Archived, so it stays out of the sidebar while the spec runs, and because
 * archiving must not rewrite history.
 */
export async function seedUsageFixture(): Promise<UsageFixture> {
	const config = JSON.parse(readFileSync(join(DEVFLOW_HOME, 'config.json'), 'utf8')) as LauncherConfig
	const client = new pg.Client({ connectionString: stackDatabaseUrl(config) })
	await client.connect()

	const at = Date.parse(`${USAGE_DAY}T15:00:00Z`)
	const taskId = randomUUID()
	const sessionId = randomUUID()
	const eventId = randomUUID()
	const taskName = `Usage e2e fixture ${taskId.slice(0, 8)}`
	const { organizationId, userId } = config

	try {
		await client.query('BEGIN')
		await client.query(
			`INSERT INTO tasks (id, organization_id, name, created_by, resource_owner_user_id, archived, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $4, true, $5, $5)`,
			[taskId, organizationId, taskName, userId, at],
		)
		await client.query(
			`INSERT INTO sessions (id, organization_id, task_id, created_by, resource_owner_user_id, host_id, working_directory,
				coding_agent, status, archived, title, created_at, updated_at, last_activity_at)
			 VALUES ($1, $2, $3, $4, $4, 'usage-e2e-fixture', '/tmp', 'claude', 'ready_for_input', true, $5, $6, $6, $6)`,
			[sessionId, organizationId, taskId, userId, taskName, at],
		)
		await client.query(
			`INSERT INTO conversation_events (id, organization_id, session_id, task_id, resource_owner_user_id, user_id,
				event_type, role, content, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $5, 'message', 'user', 'Seeded usage prompt', $6, $6)`,
			[eventId, organizationId, sessionId, taskId, userId, at + 60_000],
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
				await client.query('DELETE FROM conversation_events WHERE id = $1', [eventId])
				await client.query('DELETE FROM sessions WHERE id = $1', [sessionId])
				await client.query('DELETE FROM tasks WHERE id = $1', [taskId])
			} finally {
				await client.end()
			}
		},
	}
}
