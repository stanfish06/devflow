import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { sessions } from '@devflow/db/tables/sessions'
import { and, eq, sql } from 'drizzle-orm'

import { canWriteSession } from '../../../db/task-auth'
import { daemonBase } from '../../base'
import { extractSkillName } from './rpi-skill'

/** Restore the exact top-level workflow skill, including revisions that share a phase label. */
export const workflowSkillProcedure = daemonBase.sessions.workflowSkill.handler(async ({ input, context, errors }) => {
	const { userId, organizationId, hostId } = context.auth
	return context.services.db.transaction(
		async (db) => {
			const loadSession = async (id: string) => {
				const [row] = await db
					.select({
						id: sessions.id,
						created_at: sessions.created_at,
						host_id: sessions.host_id,
						handoff_source_session_id: sessions.handoff_source_session_id,
						task_id: sessions.task_id,
						created_by: sessions.created_by,
						resource_owner_user_id: sessions.resource_owner_user_id,
					})
					.from(sessions)
					.where(and(eq(sessions.id, id), eq(sessions.organization_id, organizationId)))
					.limit(1)
				return row
			}
			const session = await loadSession(input.sessionId)
			if (!session) throw errors.NOT_FOUND()

			// Stop at the first inaccessible source. Moving a session to another editable task
			// preserves the handoff; revoking access to an intermediate task cuts off its ancestors.
			const visited = new Set<string>()
			const links = []
			let current: typeof session | undefined = session
			let cutoff: bigint | null = null
			while (current && !visited.has(current.id)) {
				if (current.host_id !== hostId || !(await canWriteSession(db, current, userId, organizationId))) {
					if (links.length === 0) throw errors.FORBIDDEN()
					break
				}
				visited.add(current.id)
				links.push(sql`(${current.id}::uuid, ${current.handoff_source_session_id}::uuid,
			${cutoff?.toString() ?? null}::bigint, ${links.length}::int)`)
				// Freeze each source's events at the handoff that introduced its child.
				if (cutoff === null || current.created_at < cutoff) cutoff = current.created_at
				current = current.handoff_source_session_id
					? await loadSession(current.handoff_source_session_id)
					: undefined
			}
			const lineage = sql`WITH lineage(id, handoff_source_session_id, cutoff, depth) AS (
		VALUES ${sql.join(links, sql`, `)}
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
				calls.map((call) => extractSkillName('Skill', call.input, 'rpi')).find((name) => name !== undefined) ??
				null
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
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' },
	)
})
