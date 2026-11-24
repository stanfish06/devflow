/**
 * The only place that knows what "mine" means on the personal usage page.
 *
 * Every row is attributed to the user who DID the thing, never to the
 * reassignable `resource_owner_user_id`, so handing a task to someone else
 * moves nothing between their grids:
 *
 * | Counts as       | Source                 | Actor column                 | Time column   |
 * |-----------------|------------------------|------------------------------|---------------|
 * | task created    | `tasks`                | `created_by`                 | `created_at`  |
 * | session started | `sessions`             | `created_by`                 | `created_at`  |
 * | message sent    | `conversation_events`  | `user_id`, user prompts only | `created_at`  |
 * | tokens / cost   | `session_usage_events` | `session_creator_user_id`    | `occurred_at` |
 *
 * The user and organization come from authentication (see {@link UsageScope}),
 * never from the request body.
 */

import { parseDayKey } from '@devflow/api-contract/api/metrics/range'
import type { DayWindow } from '@devflow/api-contract/api/usage/windows'
import { type SQL, sql } from 'drizzle-orm'

import { bucketKeySql } from '../metrics/utils'

/** Whose history to read, and in which local calendar. */
export interface UsageScope {
	organizationId: string
	userId: string
	/** `Date.prototype.getTimezoneOffset()` minutes: positive WEST of UTC. */
	offsetMinutes: number
}

/** Inclusive real-time bounds, in epoch ms, of a window of local days. */
export interface EpochWindow {
	startMs: bigint
	endMs: bigint
}

/**
 * The real instants a window of local days covers: from the local midnight
 * opening `from` to the last millisecond of `to`. Same conversion as
 * `resolveMetricsRange`, so a day here is a day there.
 */
export function toEpochWindow(window: DayWindow, offsetMinutes: number): EpochWindow {
	// A day key names a local wall-clock midnight, which happens at real time `naive + offset`.
	const localStartMs = (key: string) => (parseDayKey(key) ?? 0) + offsetMinutes * 60_000
	return {
		startMs: BigInt(localStartMs(window.from)),
		endMs: BigInt(localStartMs(window.to) + 86_399_999),
	}
}

/**
 * The local day an epoch-ms column falls on, as 'YYYY-MM-DD' text. Built on the
 * metrics `bucketKeySql`, so the usage page and Advanced Metrics agree on days,
 * and rendered with `to_char` so the key never depends on the session DateStyle.
 */
export function dayKeySql(epochMsColumn: SQL, offsetMinutes: number): SQL {
	return sql`to_char(${bucketKeySql(epochMsColumn, 'day', offsetMinutes)}, 'YYYY-MM-DD')`
}

/**
 * Every activity of the caller inside the window, one row each:
 * `(kind: 'task' | 'session' | 'message', at, day, task_id, session_id)`.
 *
 * - **task**: a task the caller created. Drafts are left out until launched,
 *   since a saved draft hasn't started any work.
 * - **session**: a session the caller started, for a new task or a follow-up.
 * - **message**: a prompt the caller sent. Daemon-written messages (SDK echoes,
 *   tool results) carry no `user_id`, so the sender filter drops them. A fork
 *   copies its parent's events with their original sender and time, so events
 *   older than the forked session itself are copies and are skipped.
 *
 * The message branch spells `role` and `event_type` as literals rather than
 * bind parameters: they must match the predicate of the partial index
 * `conversation_events_user_messages_idx`, which the planner can only prove
 * against constants.
 */
export function myActivityEvents(scope: UsageScope, window: EpochWindow): SQL {
	const { organizationId, userId, offsetMinutes } = scope
	const { startMs, endMs } = window
	return sql`
		SELECT 'task'::text AS kind, t.created_at AS at, ${dayKeySql(sql`t.created_at`, offsetMinutes)} AS day,
			t.id AS task_id, NULL::uuid AS session_id
		FROM tasks t
		WHERE t.organization_id = ${organizationId}
			AND t.created_by = ${userId}
			AND t.is_draft = false
			AND t.created_at BETWEEN ${startMs} AND ${endMs}
		UNION ALL
		SELECT 'session'::text AS kind, s.created_at AS at, ${dayKeySql(sql`s.created_at`, offsetMinutes)} AS day,
			s.task_id, s.id AS session_id
		FROM sessions s
		WHERE s.organization_id = ${organizationId}
			AND s.created_by = ${userId}
			AND s.created_at BETWEEN ${startMs} AND ${endMs}
		UNION ALL
		SELECT 'message'::text AS kind, ce.created_at AS at, ${dayKeySql(sql`ce.created_at`, offsetMinutes)} AS day,
			ce.task_id, ce.session_id
		FROM conversation_events ce
		JOIN sessions es ON es.id = ce.session_id
		WHERE ce.organization_id = ${organizationId}
			AND ce.user_id = ${userId}
			AND ce.role = 'user'
			AND ce.event_type = 'message'
			AND ce.created_at BETWEEN ${startMs} AND ${endMs}
			AND NOT (es.forked_from_session_id IS NOT NULL AND ce.created_at < es.created_at)
	`
}

/**
 * Every usage-ledger row of the caller inside the window, one per run and model:
 * `(at, day, model, task_id, session_id, cache_read, cache_write, input, output, cost_usd)`.
 *
 * "Mine" is the session's creator, copied from `sessions.created_by` when the row
 * was recorded and never reassigned. Those are exactly the sessions whose badges
 * the user sees, so the dashboard and the badges talk about the same runs.
 * Served by `session_usage_events_org_creator_occurred_idx`.
 *
 * `input` is uncached input only (Anthropic semantics); the cache columns are
 * separate, so the four token columns add up to the badge's total.
 */
export function myUsageRows(scope: UsageScope, window: EpochWindow): SQL {
	const { organizationId, userId, offsetMinutes } = scope
	const { startMs, endMs } = window
	return sql`
		SELECT sue.occurred_at AS at, ${dayKeySql(sql`sue.occurred_at`, offsetMinutes)} AS day,
			sue.model, sue.task_id, sue.session_id,
			sue.cache_read_tokens AS cache_read, sue.cache_creation_tokens AS cache_write,
			sue.input_tokens AS input, sue.output_tokens AS output, sue.cost_usd
		FROM session_usage_events sue
		WHERE sue.organization_id = ${organizationId}
			AND sue.session_creator_user_id = ${userId}
			AND sue.occurred_at BETWEEN ${startMs} AND ${endMs}
	`
}
