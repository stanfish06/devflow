import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import { sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { type YearDayRow, zeroFillDays } from './usage-shape'
import { myActivityEvents, myUsageRows, toEpochWindow, type UsageScope } from './usage-sql'

/**
 * The caller's own year grid: tasks created, sessions started and messages
 * sent per local day, plus the tokens and dollars of the sessions they started,
 * for the 52 weeks up to the client's `today`. One response carries every lens,
 * so switching Activity / Tokens / Cost is a repaint in the browser.
 *
 * Open to every organization member, because it can only ever return the
 * caller's own rows: both IDs come from authentication.
 */
export const usageYearProcedure = effectOrpcBaseOrganizationRequired.usage.year.effect(function* ({
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
	const window = yearWindow(input.today)
	const epochWindow = toEpochWindow(window, scope.offsetMinutes)

	// Each side is aggregated per day before the join, so a day's ledger rows can't
	// multiply its activity counts or the other way round.
	const rows = yield* postgres
		.query(
			postgres.client.execute<YearDayRow>(sql`
				WITH activity_by_day AS (
					SELECT
						day,
						COUNT(*) FILTER (WHERE kind = 'task')::int AS tasks,
						COUNT(*) FILTER (WHERE kind = 'session')::int AS sessions,
						COUNT(*) FILTER (WHERE kind = 'message')::int AS messages
					FROM (${myActivityEvents(scope, epochWindow)}) activity
					GROUP BY day
				),
				usage_by_day AS (
					SELECT
						day,
						COUNT(*)::int AS ledger_rows,
						SUM(cache_read)::bigint AS cache_read,
						SUM(cache_write)::bigint AS cache_write,
						SUM(input)::bigint AS input,
						SUM(output)::bigint AS output,
						SUM(cost_usd)::float8 AS cost_usd
					FROM (${myUsageRows(scope, epochWindow)}) ledger
					GROUP BY day
				)
				SELECT
					COALESCE(a.day, u.day) AS day,
					a.tasks, a.sessions, a.messages,
					u.ledger_rows, u.cache_read, u.cache_write, u.input, u.output, u.cost_usd
				FROM activity_by_day a
				FULL JOIN usage_by_day u ON u.day = a.day
				ORDER BY 1
			`),
		)
		.pipe(
			Effect.tapError((error) => Effect.logError(error)),
			Effect.catchTags({
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)

	return { days: zeroFillDays(Array.from(rows), window) }
})
