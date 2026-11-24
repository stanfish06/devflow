import { organizationSettings } from '@devflow/db/tables/organization-settings'
import { userSettings } from '@devflow/db/tables/user-settings'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../effects/services/postgres/postgres-db.service'
import { effectOrpcDaemonBase } from '../../effect-base'

const USER_DEFAULTS = {
	experimental_subagents_enabled: false,
	claude_code_effect_runtime_enabled: false,
	haiku_research_subagents_enabled: false,
	// TRUE, matching the column default: a member with no user_settings row at all has made no
	// choice, and the org opt-in is the decision that matters. This is the reader that actually
	// governs collection for a fresh member — the column default never runs for them, because no
	// row is ever inserted until they change a setting.
	metrics_advanced_enabled: true,
}

const ORG_DEFAULTS = {
	experimental_subagents_enabled: false,
	haiku_research_subagents_enabled: false,
	commit_tracking_enabled: false,
	pr_tracking_enabled: false,
}

export const daemonGetSettingsEffectProcedure = effectOrpcDaemonBase.settings.get.effect(function* ({
	context,
	errors,
}) {
	// services
	const postgres = yield* PostgresDb

	// impl
	const { userId, organizationId } = context.auth

	const result = yield* Effect.all(
		[
			postgres.query(
				postgres.client
					.select()
					.from(userSettings)
					.where(and(eq(userSettings.user_id, userId), eq(userSettings.organization_id, organizationId))),
			),
			postgres.query(
				postgres.client
					.select()
					.from(organizationSettings)
					.where(eq(organizationSettings.organization_id, organizationId)),
			),
		],
		{ concurrency: 'unbounded' },
	).pipe(
		Effect.map(([userRows, orgRows]) => {
			const user = userRows[0] ?? USER_DEFAULTS
			const org = orgRows[0] ?? ORG_DEFAULTS

			return {
				experimentalSubagentsEnabled: org.experimental_subagents_enabled && user.experimental_subagents_enabled,
				claudeCodeEffectRuntimeEnabled: user.claude_code_effect_runtime_enabled,
				haikuResearchSubagentsEnabled:
					org.haiku_research_subagents_enabled && user.haiku_research_subagents_enabled,
				// The org flags are the opt-in; the per-user metrics_advanced_enabled is an
				// admin-controlled exclusion, defaulting on. Both org flags still default OFF, so an
				// org that has not opted in collects nothing regardless of what any member's row
				// says. No coalesce on the member term: the column is notNull and the row-absent
				// case is USER_DEFAULTS above, so a `?? true` here would be a second, unreachable
				// copy of the same default — the sibling flags above rely on USER_DEFAULTS the same way.
				commitTrackingEnabled: (org.commit_tracking_enabled ?? false) && user.metrics_advanced_enabled,
				// Org-wide: the member exclusion does not apply to pull request tracking.
				prTrackingEnabled: org.pr_tracking_enabled ?? false,
			}
		}),
		Effect.tapError((e) => Effect.logError(e)),
		Effect.catchTags({
			PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
		}),
	)

	yield* Effect.logInfo('Daemon settings fetched').pipe(Effect.annotateLogs({ userId, organizationId }))

	return result
})
