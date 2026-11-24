import { DAEMON_ACTIVE_SESSION_STATUSES, type Session, type SessionStatus } from '@devflow/db/tables/sessions'

import type { TaskRow } from '@/minimalist/lib/data'
import { toMs } from '@/minimalist/lib/format'

/** What a board card says its agent is doing. Never stored: it's read from the synced rows. */
export type CardState = 'draft' | 'needs-you' | 'failed' | 'running' | 'stopped' | 'finished'

/**
 * The one thing a card's button does. Needs you and Finished have none: clicking the card opens
 * the thread, where approvals and new instructions belong.
 */
export type CardAction =
	| { kind: 'start' }
	/** Every session that can be interrupted now. */
	| { kind: 'stop'; sessionIds: string[] }
	/** The most recently active stopped session. */
	| { kind: 'resume'; sessionId: string }
	/**
	 * The most recently active failed or stalled session. `relaunch` when its agent never started
	 * (no coding agent session id), so there's no conversation to continue.
	 */
	| { kind: 'retry'; sessionId: string; relaunch: boolean }
	| null

export const CARD_STATE_LABELS: Record<CardState, string> = {
	draft: 'Draft',
	'needs-you': 'Needs you',
	failed: 'Failed',
	running: 'Running',
	stopped: 'Stopped',
	finished: 'Finished',
}

type SessionState = Exclude<CardState, 'draft'>

/** Which card state one session puts its task in; null for a session draft, which hasn't started. */
function sessionState(status: SessionStatus): SessionState | null {
	switch (status) {
		case 'needs_approval':
			return 'needs-you'
		case 'failed':
		case 'lost':
			return 'failed'
		case 'ready_for_launch':
		case 'waiting_for_workspace':
		case 'launching':
		case 'running':
		case 'resuming':
		case 'waiting_for_usage_limit':
		case 'interrupt_requested':
			return 'running'
		case 'interrupted':
			return 'stopped'
		case 'ready_for_input':
			return 'finished'
		default:
			return null
	}
}

// Most urgent first, as the PRD ranks them: Needs you > Failed > Running > Stopped > Finished.
const STATE_RANK: Record<SessionState, number> = {
	'needs-you': 5,
	failed: 4,
	running: 3,
	stopped: 2,
	finished: 1,
}

/** The sessions sessions.interrupt accepts: anything else is queued, already stopping, or done. */
const INTERRUPTIBLE = new Set<SessionStatus>(DAEMON_ACTIVE_SESSION_STATUSES)

type CardSession = Pick<
	Session,
	'id' | 'status' | 'archived' | 'coding_agent_session_id' | 'last_activity_at' | 'updated_at' | 'created_at'
>

function activity(session: CardSession): number {
	return Math.max(toMs(session.last_activity_at), toMs(session.updated_at), toMs(session.created_at))
}

function mostRecent<S extends CardSession>(sessions: readonly S[]): S | undefined {
	let best: S | undefined
	for (const session of sessions) if (!best || activity(session) > activity(best)) best = session
	return best
}

/**
 * A card's agent state and its action, across all of the task's sessions. A ticket is one unit
 * on the board: the most urgent session decides the state, Stop stops every session that's
 * working, and Resume / Retry pick up the most recent one. Per-session control stays in the task.
 */
export function cardAgent(row: {
	task: Pick<TaskRow['task'], 'is_draft'>
	sessions: readonly CardSession[]
	attention?: TaskRow['attention']
}): { state: CardState; action: CardAction } {
	if (row.task.is_draft) return { state: 'draft', action: { kind: 'start' } }
	const sessions = row.sessions.filter((session) => !session.archived)
	let state: SessionState | null = null
	for (const session of sessions) {
		const next = sessionState(session.status)
		if (next && (!state || STATE_RANK[next] > STATE_RANK[state])) state = next
	}
	switch (state) {
		case 'failed': {
			const failed = mostRecent(sessions.filter((session) => sessionState(session.status) === 'failed'))
			return {
				state,
				action: failed
					? { kind: 'retry', sessionId: failed.id, relaunch: !failed.coding_agent_session_id }
					: null,
			}
		}
		case 'running': {
			const sessionIds = sessions
				.filter((session) => INTERRUPTIBLE.has(session.status))
				.map((session) => session.id)
			// Failed setup holds queued sessions; keep Stop available for any session already working.
			if (row.attention === 'failed' && sessionIds.length === 0) return { state: 'failed', action: null }
			return { state, action: sessionIds.length > 0 ? { kind: 'stop', sessionIds } : null }
		}
		case 'stopped': {
			const stopped = mostRecent(sessions.filter((session) => session.status === 'interrupted'))
			return { state, action: stopped ? { kind: 'resume', sessionId: stopped.id } : null }
		}
		case 'needs-you':
		case 'finished':
			return { state, action: null }
		default:
			// A launched task whose sessions are all archived or never started has nothing working.
			return { state: 'finished', action: null }
	}
}
