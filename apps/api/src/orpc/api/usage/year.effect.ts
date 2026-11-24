import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import { sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { type ActivityDayRow, zeroFillDays } from './usage-shape'
import { myActivityEvents, toEpochWindow, type UsageScope } from './usage-sql'

/**
 * The caller's own year grid: tasks created, sessions started and messages
 * sent per local day, for the 52 weeks up to the client's `today`.
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

	const rows = yield* postgres
		.query(
			postgres.client.execute<ActivityDayRow>(sql`
				WITH activity AS (${myActivityEvents(scope, toEpochWindow(window, scope.offsetMinutes))})
				SELECT
					day,
					COUNT(*) FILTER (WHERE kind = 'task')::int AS tasks,
					COUNT(*) FILTER (WHERE kind = 'session')::int AS sessions,
					COUNT(*) FILTER (WHERE kind = 'message')::int AS messages
				FROM activity
				GROUP BY day
				ORDER BY day
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
