import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { sessions } from '@devflow/db/tables/sessions'
import { and, eq, sql } from 'drizzle-orm'

import { canWriteSession } from '../../../db/task-auth'
import { daemonBase } from '../../base'
import { extractSkillName } from './rpi-skill'

/** Restore the exact top-level workflow skill, including revisions that share a phase label. */
export const workflowSkillProcedure = daemonBase.sessions.workflowSkill.handler(async ({ input, context, errors }) => {
	const { userId, organizationId, hostId } = context.auth
	const db = context.services.db
	const [session] = await db
		.select({
			host_id: sessions.host_id,
			handoff_source_session_id: sessions.handoff_source_session_id,
			task_id: sessions.task_id,
			created_by: sessions.created_by,
			resource_owner_user_id: sessions.resource_owner_user_id,
		})
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.organization_id, organizationId)))
		.limit(1)
	if (!session) throw errors.NOT_FOUND()
	if (session.host_id !== hostId || !(await canWriteSession(db, session, userId, organizationId))) {
		throw errors.FORBIDDEN()
	}

	// A handoff can point to another handoff. Each source stops at the time its child
	// was created, even if the source later continued along a different conversation.
	// Matching the authorized session's access fields makes its edit permission apply to every link.
	const lineage = sql`WITH RECURSIVE accessible AS NOT MATERIALIZED (
		SELECT id, created_at, handoff_source_session_id FROM ${sessions}
		WHERE organization_id = ${organizationId} AND host_id = ${hostId}
			AND created_by = ${userId} AND resource_owner_user_id = ${session.resource_owner_user_id}
			AND task_id IS NOT DISTINCT FROM ${session.task_id}::uuid
	), lineage AS (
		SELECT id, created_at, handoff_source_session_id, NULL::bigint AS cutoff,
			0 AS depth, ARRAY[id] AS visited
		FROM accessible WHERE id = ${input.sessionId}
		UNION ALL
		SELECT parent.id, parent.created_at, parent.handoff_source_session_id,
			least(child.created_at, child.cutoff), child.depth + 1, child.visited || parent.id
		FROM lineage child
		JOIN accessible parent ON parent.id = child.handoff_source_session_id
		WHERE NOT parent.id = ANY(child.visited)
	)`
	const rootEvents = sql`FROM lineage l JOIN ${conversationEvents} e ON e.session_id = l.id
		WHERE e.organization_id = ${organizationId} AND e.parent_tool_use_id IS NULL
			AND (l.cutoff IS NULL OR e.created_at <= l.cutoff)`
	const calls = await db.execute<{ input: unknown }>(sql`
		${lineage}
		SELECT e.tool_input_json AS input ${rootEvents}
			AND e.event_type = 'tool_call' AND e.role = 'assistant' AND lower(e.tool_name) = 'skill'
		ORDER BY l.depth, e.created_at DESC, e.id DESC
	`)
	const skill =
		calls.map((call) => extractSkillName('Skill', call.input, 'rpi')).find((name) => name !== undefined) ?? null
	// A live app-server already owns the dialogue. Older runners ask for it implicitly during workflows.
	const includeConversation =
		input.includeConversation ?? (skill !== null || session.handoff_source_session_id !== null)
	if (!includeConversation) return { skill, conversation: [] }

	// Only the destination has user messages that the runner is about to dispatch.
	// Collapse progress updates within each session, and omit each handoff's wrapper:
	// its actual exchanges come from the corresponding source.
	const messageChars = 8192
	const conversation = await db.execute<{ role: 'user' | 'assistant'; content: string }>(sql`
		${lineage}, messages AS (
			SELECT e.id, e.created_at, e.role, e.content, l.depth, l.handoff_source_session_id,
				lag(e.role) OVER newest AS newer_role,
				count(*) FILTER (WHERE e.role = 'assistant') OVER newest AS assistant_count,
				row_number() OVER (PARTITION BY l.id ORDER BY e.created_at, e.id) AS position
			${rootEvents}
				AND e.event_type = 'message' AND e.role IN ('user', 'assistant') AND e.content ~ '[^[:space:]]'
			WINDOW newest AS (PARTITION BY l.id ORDER BY e.created_at DESC, e.id DESC)
		)
		SELECT role, CASE WHEN length(content) > ${messageChars}
			THEN left(content, ${messageChars / 2}) || E'\\n[…]\\n' || right(content, ${messageChars / 2}) ELSE content END AS content
		FROM messages
		WHERE (depth > 0 OR assistant_count > 0) AND (role = 'user' OR newer_role IS DISTINCT FROM 'assistant')
			AND NOT (handoff_source_session_id IS NOT NULL AND position = 1 AND role = 'user')
		ORDER BY depth, created_at DESC, id DESC
		LIMIT 12
	`)
	return { skill, conversation: [...conversation].reverse() }
})
