import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresReadReplicaDb } from '../../../effects/services/postgres/postgres-read-replica.service'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { type YearDayRow, zeroFillDays } from './usage-shape'
import { myDailyUsage, toEpochWindow, type UsageScope } from './usage-sql'

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

	const rows = yield* postgres.query(postgres.client.execute<YearDayRow>(myDailyUsage(scope, epochWindow))).pipe(
		Effect.tapError((error) => Effect.logError(error)),
		Effect.catchTags({
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)

	return { days: zeroFillDays(Array.from(rows), window) }
})
