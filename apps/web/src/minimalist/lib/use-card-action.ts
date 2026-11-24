import type { Task } from '@devflow/db/tables/tasks'
import { ORPCError } from '@orpc/client'
import { uuidv7 } from 'uuidv7'

import type { CardAction } from '@/minimalist/lib/card-agent'
import { useProjects } from '@/minimalist/lib/data'
import { launchFailure, type StartTaskInput, startTask } from '@/minimalist/lib/launch'
import { parseDraftLaunch, toStartInput } from '@/minimalist/lib/launch-form'
import { sendToSession } from '@/minimalist/lib/send'
import { useUi } from '@/minimalist/lib/ui-state'
import { useApi } from '@/orpc/client'

/** What a card's Resume sends: the agent picks up the same conversation, and the thread shows it. */
export const RESUME_TEXT = 'Continue where you left off.'
/** What a card's Retry sends to a failed or stalled session. */
export const RETRY_TEXT = 'Try again.'

/** The session left an active status between the card's read and the call: it's already stopped. */
function alreadyStopped(error: unknown): boolean {
	return error instanceof ORPCError && error.code === 'BAD_REQUEST'
}

/**
 * Carries out a card's action over the endpoints the thread already uses. Nothing is optimistic:
 * the card changes when the synced rows do. A failure shows one toast; nothing throws.
 */
export function useCardAction(): (row: { task: Task }, action: NonNullable<CardAction>) => Promise<void> {
	const { client: api } = useApi()
	const { showToast } = useUi()
	const projects = useProjects()

	/** Starts a draft as it was saved, in place: it keeps its column, since no status is sent. */
	const start = async (task: Task) => {
		let input: StartTaskInput
		try {
			const parsed = parseDraftLaunch(task.draft_launch)
			const target = parsed.ok ? parsed.snapshot.target : null
			const project =
				target?.kind === 'project' ? projects.data?.find((entry) => entry.id === target.projectId) : undefined
			input = toStartInput(task, project, { sessionId: uuidv7(), eventId: uuidv7() })
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not read this draft. Open it to start it.')
			return
		}
		try {
			await startTask(api, input)
		} catch (error) {
			showToast(['Could not start the draft.', launchFailure(error) ?? 'Try again.'].join(' '))
		}
	}

	/** Stops every working session on the ticket; one already stopped counts as stopped. */
	const stop = async (sessionIds: readonly string[]) => {
		const results = await Promise.allSettled(
			sessionIds.map((sessionId) => api.sessions.interrupt({ sessionId }, { context: { silent: true } })),
		)
		const failed = results.filter((result) => result.status === 'rejected' && !alreadyStopped(result.reason)).length
		if (failed === 0) return
		showToast(
			sessionIds.length === 1
				? 'Could not stop the agent. Try again.'
				: `Could not stop ${failed} of ${sessionIds.length} sessions. Try again.`,
		)
	}

	const send = async (sessionId: string, text: string, origin: 'card_resume' | 'card_retry', failure: string) => {
		try {
			await sendToSession(api, sessionId, text, 'send', { origin, silent: true })
		} catch {
			showToast(failure)
		}
	}

	return async (row, action) => {
		switch (action.kind) {
			case 'start':
				return start(row.task)
			case 'stop':
				return stop(action.sessionIds)
			case 'resume':
				return send(action.sessionId, RESUME_TEXT, 'card_resume', 'Could not resume the agent. Try again.')
			case 'retry':
				if (action.relaunch) {
					try {
						await api.sessions.relaunch({ sessionId: action.sessionId }, { context: { silent: true } })
					} catch {
						showToast('Could not retry the agent. Try again.')
					}
					return
				}
				return send(action.sessionId, RETRY_TEXT, 'card_retry', 'Could not retry the agent. Try again.')
		}
	}
}
