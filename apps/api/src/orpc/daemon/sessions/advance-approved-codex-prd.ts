import { artifactOperationsLog } from '@devflow/db/tables/artifact-operations-log'
import { artifactVersions } from '@devflow/db/tables/artifact-versions'
import { artifacts } from '@devflow/db/tables/artifacts'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { sessions } from '@devflow/db/tables/sessions'
import type { tasks } from '@devflow/db/tables/tasks'
import type { NextStepSuggestion } from '@devflow/db/zodschemas/next-step'
import { and, desc, eq, gt, gte, inArray, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'

import { createSessionForLaunch } from '../../../db/create-session-for-launch'

/** Codex uploads its artifact writes before reporting ready. The approved PRD is the stage boundary. */
export async function advanceApprovedCodexPrd(
	tx: PgDatabase<PostgresJsQueryResultHKT>,
	organizationId: string,
	task: Pick<typeof tasks.$inferSelect, 'id' | 'name' | 'slug'>,
	sessionId: string,
): Promise<boolean> {
	// #>> '{}' unwraps the JSON string stored by older daemons as well as native JSONB.
	const labels = sql`(${sessions.labels} #>> '{}')::jsonb`
	const [source] = await tx
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.organization_id, organizationId),
				eq(sessions.task_id, task.id),
				eq(sessions.provider, 'codex'),
				eq(sessions.archived, false),
				eq(sessions.status, 'ready_for_input'),
				sql`${labels} @> '[{"name":"rpi:design-prd"}]'::jsonb`,
			),
		)
	if (!source) return false

	const rootMessage = and(
		eq(conversationEvents.session_id, sessionId),
		eq(conversationEvents.organization_id, organizationId),
		eq(conversationEvents.event_type, 'message'),
		isNull(conversationEvents.parent_tool_use_id),
	)
	const [latestInput] = await tx
		.select({ at: conversationEvents.created_at })
		.from(conversationEvents)
		.where(and(rootMessage, eq(conversationEvents.role, 'user')))
		.orderBy(desc(conversationEvents.created_at))
		.limit(1)
	const turnStart = latestInput?.at ?? source.created_at
	const frontmatter = sql`(${artifacts.frontmatter} #>> '{}')::jsonb`
	// A draft, a deleted document, or an approval left over from a prior interview cannot advance this turn.
	const [prd] = await tx
		.select({ status: sql<string>`${frontmatter} ->> 'status'`, writer: artifactOperationsLog.session_id })
		.from(artifactOperationsLog)
		.innerJoin(artifacts, eq(artifacts.id, artifactOperationsLog.artifact_id))
		.where(
			and(
				eq(artifacts.task_id, task.id),
				eq(artifacts.organization_id, organizationId),
				eq(artifacts.is_deleted, false),
				gte(artifactOperationsLog.created_at, turnStart),
				// A later content revision supersedes this write. Sharing or renaming the artifact does not.
				notExists(
					tx
						.select({ id: artifactVersions.id })
						.from(artifactVersions)
						.where(
							and(
								eq(artifactVersions.artifact_id, artifacts.id),
								gt(artifactVersions.created_at, artifactOperationsLog.created_at),
							),
						),
				),
				inArray(artifactOperationsLog.operation_type, ['Write', 'Edit', 'MultiEdit']),
				sql`${frontmatter} ->> 'type' = 'design-prd'`,
			),
		)
		.orderBy(desc(artifactOperationsLog.created_at), desc(artifactOperationsLog.id))
		.limit(1)
	if (prd?.status !== 'approved' || prd.writer !== sessionId) return false

	const [existing] = await tx
		.select({ archived: sessions.archived })
		.from(sessions)
		.where(
			and(
				eq(sessions.task_id, task.id),
				eq(sessions.organization_id, organizationId),
				ne(sessions.id, source.id),
				gte(sessions.created_at, source.created_at),
				or(eq(sessions.archived, false), gte(sessions.created_at, turnStart)),
				sql`${labels} @> '[{"name":"rpi:design-tdd"}]'::jsonb`,
			),
		)
		.limit(1)
	// Preserve an explicit archive on ready retries for this turn.
	if (existing?.archived) return true

	const taskReference = `.devflow/tasks/${task.slug || task.name}`
	if (!existing) {
		await createSessionForLaunch(tx, {
			taskId: task.id,
			organizationId,
			resourceOwnerUserId: source.resource_owner_user_id,
			createdBy: source.created_by,
			title: `design-tdd: ${task.name}`,
			prompt: `use the rpi:create-tdd skill for ${taskReference}`,
			workingDirectory: source.working_directory,
			hostId: source.host_id,
			codingAgent: source.coding_agent,
			provider: 'codex',
			model: source.model,
			effort: source.effort ?? undefined,
			fastMode: source.fast_mode,
			permissionsMode: source.permissions_mode,
			labels: [{ name: 'rpi:design-tdd', title: 'design-tdd' }],
		})
	}

	// The existing Next Step card opens the new sibling even when the model used a prose handoff.
	const suggestion: NextStepSuggestion = {
		parsedAt: Date.now(),
		extraction: {
			type: 'next_step_found',
			nextStepType: 'create-tdd',
			nextStepSummary: 'Create TDD',
			nextStepPrompt: `/rpi:create-tdd for ${taskReference}`,
			taskReference,
		},
	}
	await tx
		.update(sessions)
		.set({ next_step_suggestions: [suggestion] })
		.where(eq(sessions.id, sessionId))
	const [lastReply] = await tx
		.select({ id: conversationEvents.id })
		.from(conversationEvents)
		.where(
			and(rootMessage, eq(conversationEvents.role, 'assistant'), gte(conversationEvents.created_at, turnStart)),
		)
		.orderBy(desc(conversationEvents.created_at), desc(conversationEvents.id))
		.limit(1)
	if (lastReply)
		await tx
			.update(conversationEvents)
			.set({ next_step_suggestion: suggestion })
			.where(eq(conversationEvents.id, lastReply.id))
	return true
}
