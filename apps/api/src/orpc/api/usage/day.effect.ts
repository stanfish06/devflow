import { sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { buildDayRows, type DayItemRow } from './usage-shape'
import { myActivityEvents, myUsageRows, toEpochWindow, type UsageScope } from './usage-sql'

/**
 * What the caller worked on during one local day: a row per task, and a row per session with no task,
 * built from the same activity and ledger rows as the year grid over that single day, so a day's rows
 * add up to its cell.
 *
 * An activity or ledger row belongs to its task when it has one, through its session when the row
 * itself doesn't say (a prompt's event may carry no task id), and otherwise to its session.
 *
 * Open to every organization member, because it can only ever return the caller's own rows: both IDs
 * come from authentication.
 */
export const usageDayProcedure = effectOrpcBaseOrganizationRequired.usage.day.effect(function* ({
	context,
	input,
	errors,
}) {
	const postgres = yield* PostgresReadReplicaDb
	const scope: UsageScope = {
		organizationId: context.auth.organizationId,
		userId: context.auth.userId,
		offsetMinutes: input.timezoneOffset ?? 0,
	}
	const epochWindow = toEpochWindow({ from: input.date, to: input.date }, scope.offsetMinutes)

	// Each side is aggregated per item before the join, so an item's ledger rows can't multiply its
	// activity counts or the other way round.
	const rows = yield* postgres
		.query(
			postgres.client.execute<DayItemRow>(sql`
				WITH activity AS (
					SELECT
						a.kind,
						CASE WHEN COALESCE(a.task_id, s.task_id) IS NULL THEN 'session' ELSE 'task' END AS item_kind,
						COALESCE(a.task_id, s.task_id, a.session_id) AS item_id
					FROM (${myActivityEvents(scope, epochWindow)}) a
					LEFT JOIN sessions s ON s.id = a.session_id
				),
				activity_by_item AS (
					SELECT
						item_kind,
						item_id,
						-- A task row's own creation, or a session row's own start.
						bool_or(kind = item_kind) AS created,
						COUNT(*) FILTER (WHERE kind = 'session')::int AS sessions,
						COUNT(*) FILTER (WHERE kind = 'message')::int AS messages
					FROM activity
					GROUP BY item_kind, item_id
				),
				ledger AS (
					SELECT
						CASE WHEN COALESCE(u.task_id, s.task_id) IS NULL THEN 'session' ELSE 'task' END AS item_kind,
						COALESCE(u.task_id, s.task_id, u.session_id) AS item_id,
						u.cache_read::bigint + u.cache_write + u.input + u.output AS tokens,
						u.cost_usd
					FROM (${myUsageRows(scope, epochWindow)}) u
					LEFT JOIN sessions s ON s.id = u.session_id
				),
				usage_by_item AS (
					SELECT
						item_kind,
						item_id,
						COUNT(*)::int AS ledger_rows,
						SUM(tokens)::bigint AS tokens,
						SUM(cost_usd)::float8 AS cost_usd
					FROM ledger
					GROUP BY item_kind, item_id
				),
				items AS (
					SELECT
						COALESCE(a.item_kind, u.item_kind) AS kind,
						COALESCE(a.item_id, u.item_id) AS id,
						a.created, a.sessions, a.messages,
						u.ledger_rows, u.tokens, u.cost_usd
					FROM activity_by_item a
					FULL JOIN usage_by_item u ON u.item_kind = a.item_kind AND u.item_id = a.item_id
				)
				SELECT
					i.kind,
					i.id::text AS id,
					CASE
						WHEN i.kind = 'task' THEN t.name
						ELSE COALESCE(NULLIF(btrim(s.title), ''), NULLIF(btrim(s.summary), ''))
					END AS name,
					CASE WHEN i.kind = 'task' THEN t.archived ELSE s.archived END AS archived,
					i.created, i.sessions, i.messages,
					i.ledger_rows, i.tokens, i.cost_usd
				FROM items i
				LEFT JOIN tasks t
					ON i.kind = 'task' AND t.id = i.id AND t.organization_id = ${scope.organizationId}
				LEFT JOIN sessions s
					ON i.kind = 'session' AND s.id = i.id AND s.organization_id = ${scope.organizationId}
			`),
		)
		.pipe(
			Effect.tapError((error) => Effect.logError(error)),
			Effect.catchTags({
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)

	return { rows: buildDayRows(Array.from(rows)) }
})
