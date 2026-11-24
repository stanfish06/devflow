import { periodWindows } from '@devflow/api-contract/api/usage/windows'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { sumTotals, type YearDayRow } from './usage-shape'
import { myDailyUsage, toEpochWindow, type UsageScope } from './usage-sql'

/**
 * The caller's totals for a calendar period to date (week, month or the last twelve months), and for
 * the same stretch of the period before it, as of the client's `today`.
 *
 * Both windows come from one per-day read spanning the previous window's first day to today, built from
 * the same fragments as the year grid, so a period's totals are the sum of its grid cells. Splitting
 * the days between the windows is pure code (`sumTotals`).
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
	const epochWindow = toEpochWindow({ from: windows.previous.from, to: windows.current.to }, scope.offsetMinutes)

	const rows = yield* postgres.query(postgres.client.execute<YearDayRow>(myDailyUsage(scope, epochWindow))).pipe(
		Effect.tapError((error) => Effect.logError(error)),
		Effect.catchTags({
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)

	const days = Array.from(rows)
	return {
		current: sumTotals(days, windows.current),
		previous: sumTotals(days, windows.previous),
	}
})
