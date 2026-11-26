import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { sessions } from '@devflow/db/tables/sessions'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

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

	const calls = await db
		.select({ input: conversationEvents.tool_input_json })
		.from(conversationEvents)
		.where(
			and(
				eq(conversationEvents.session_id, input.sessionId),
				eq(conversationEvents.organization_id, organizationId),
				eq(conversationEvents.event_type, 'tool_call'),
				eq(conversationEvents.role, 'assistant'),
				isNull(conversationEvents.parent_tool_use_id),
				eq(sql<string>`lower(${conversationEvents.tool_name})`, 'skill'),
			),
		)
		.orderBy(desc(conversationEvents.created_at), desc(conversationEvents.id))
	const skill =
		calls.map((call) => extractSkillName('Skill', call.input, 'rpi')).find((name) => name !== undefined) ?? null
	if (!skill) return { skill: null, conversation: [] }

	// The API persists the current input (possibly several queued user messages) before dispatch.
	// End at the latest completed assistant reply. Keep only the last assistant message between
	// user replies so a long sequence of progress updates cannot displace the interview questions.
	const conversation = await db.execute<{ role: 'user' | 'assistant'; content: string }>(sql`
		WITH messages AS (
			SELECT id, created_at, role, content,
				lag(role) OVER newest AS newer_role,
				count(*) FILTER (WHERE role = 'assistant') OVER newest AS assistant_count,
				row_number() OVER (ORDER BY created_at, id) AS position
			FROM ${conversationEvents}
			WHERE session_id = ${input.sessionId} AND organization_id = ${organizationId}
				AND event_type = 'message' AND parent_tool_use_id IS NULL
				AND role IN ('user', 'assistant') AND content ~ '[^[:space:]]'
			WINDOW newest AS (ORDER BY created_at DESC, id DESC)
		)
		SELECT role, CASE WHEN length(content) > 2048
			THEN left(content, 1024) || E'\\n[…]\\n' || right(content, 1024) ELSE content END AS content
		FROM messages
		WHERE assistant_count > 0 AND (role = 'user' OR newer_role IS DISTINCT FROM 'assistant')
			AND NOT (${session.handoff_source_session_id !== null} AND position = 1 AND role = 'user')
		ORDER BY created_at DESC, id DESC
		LIMIT 12
	`)
	return { skill, conversation: [...conversation].reverse() }
})
