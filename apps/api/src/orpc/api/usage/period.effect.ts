import { USAGE_TOP_TASKS } from '@devflow/api-contract/api/usage/period'
import { periodWindows } from '@devflow/api-contract/api/usage/windows'
import { sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import {
	denseBuckets,
	type ModelDayRow,
	rankByModel,
	rankTopTasks,
	sumTotals,
	type TopTaskRow,
	type YearDayRow,
} from './usage-shape'
import { myDailyUsage, myUsageRows, toEpochWindow, type UsageScope } from './usage-sql'

/**
 * The caller's totals for a calendar period to date (week, month or the last twelve months), and for
 * the same stretch of the period before it, as of the client's `today`; plus, for the current period,
 * where the money went: cost per model per chart bucket, per model overall, and the top tasks.
 *
 * Both windows' totals come from one per-day read spanning the previous window's first day to today,
 * built from the same fragments as the year grid, so a period's totals are the sum of its grid cells.
 * The breakdowns read the same ledger rows over the current window. Splitting days between windows and
 * slots, and ranking, is pure code (`usage-shape.ts`).
 *
 * Open to every organization member, because it can only ever return the caller's own rows: both IDs
 * come from authentication.
 */
export const usagePeriodProcedure = effectOrpcBaseOrganizationRequired.usage.period.effect(function* ({
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
	const windows = periodWindows(input.period, input.today)
	const bothWindows = toEpochWindow({ from: windows.previous.from, to: windows.current.to }, scope.offsetMinutes)
	const currentWindow = toEpochWindow(windows.current, scope.offsetMinutes)

	const daily = postgres.client.execute<YearDayRow>(myDailyUsage(scope, bothWindows))

	// Per local day rather than per bucket, so the year period's month buckets are cut by the same day
	// keys as everything else; `denseBuckets` folds the days into slots.
	const modelDays = postgres.client.execute<ModelDayRow>(sql`
		SELECT day, model, SUM(cost_usd)::float8 AS cost_usd
		FROM (${myUsageRows(scope, currentWindow)}) u
		GROUP BY day, model
	`)

	// A ledger row belongs to its task, or through its session when the row itself doesn't say, as in
	// the day list. Rows of sessions with no task have no place in a table of tasks.
	const topTasks = postgres.client.execute<TopTaskRow>(sql`
		WITH ledger AS (
			SELECT
				COALESCE(u.task_id, s.task_id) AS task_id,
				u.cache_read::bigint + u.cache_write + u.input + u.output AS tokens,
				u.cost_usd
			FROM (${myUsageRows(scope, currentWindow)}) u
			LEFT JOIN sessions s ON s.id = u.session_id
		),
		by_task AS (
			SELECT task_id, SUM(tokens)::bigint AS tokens, COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
			FROM ledger
			WHERE task_id IS NOT NULL
			GROUP BY task_id
		)
		SELECT b.task_id::text AS task_id, t.name, t.archived, b.tokens, b.cost_usd
		FROM by_task b
		JOIN tasks t ON t.id = b.task_id AND t.organization_id = ${scope.organizationId}
		ORDER BY b.cost_usd DESC, b.tokens DESC, t.name, b.task_id
		LIMIT ${USAGE_TOP_TASKS}
	`)

	const [dayRows, modelRows, taskRows] = yield* Effect.all(
		[postgres.query(daily), postgres.query(modelDays), postgres.query(topTasks)],
		{ concurrency: 'unbounded' },
	).pipe(
		Effect.tapError((error) => Effect.logError(error)),
		Effect.catchTags({
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)

	const days = Array.from(dayRows)
	const models = Array.from(modelRows)
	return {
		current: sumTotals(days, windows.current),
		previous: sumTotals(days, windows.previous),
		buckets: denseBuckets(models, windows.slots, windows.current),
		byModel: rankByModel(models, windows.current),
		topTasks: rankTopTasks(Array.from(taskRows)),
	}
})
