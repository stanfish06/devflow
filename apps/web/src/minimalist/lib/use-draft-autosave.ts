import type { TaskStatus } from '@devflow/schemas/effect/taskconfiguration'
import { useEffect, useRef, useState } from 'react'

import { useMountEffect } from '@/hooks/useMountEffect'
import { type DraftLaunch, draftSaveInput } from '@/minimalist/lib/launch-form'
import type { Ticket } from '@/minimalist/lib/tickets'
import { useUi } from '@/minimalist/lib/ui-state'
import { useApi } from '@/orpc/client'

/** How long typing pauses before an open draft saves. */
export const AUTOSAVE_DELAY_MS = 800
export const DRAFT_GONE_MESSAGE = 'This draft was started or deleted elsewhere'

/**
 * What a save sends besides the snapshot: the linked issue, which lives on the row, and the column
 * the card is in now. Saves read the column when they go out, so one dragged elsewhere while the
 * draft is open stays where it was dragged.
 */
export type DraftRowFields = { ticket: Ticket | null; status: TaskStatus }

export type DraftAutosaveState = 'idle' | 'saving' | 'saved' | 'error'

type Pending = { taskId: string; snapshot: DraftLaunch; row: DraftRowFields; key: string }

/**
 * Saves an open draft as it's edited, through the same `tasks.saveDraft` Save as draft uses. Edits
 * wait for a pause in typing; what the row already holds isn't sent again; one save goes out at a
 * time, and edits made meanwhile follow in one more. A draft started or deleted elsewhere stops
 * saving, with a toast. Leaving the page saves what's pending. `taskId` null turns it off.
 */
export function useDraftAutosave(taskId: string | null, snapshot: DraftLaunch | null, row: DraftRowFields) {
	const { client: api } = useApi()
	const { showToast } = useUi()
	const [state, setState] = useState<DraftAutosaveState>('idle')
	const [savedAt, setSavedAt] = useState<number | null>(null)
	const key = taskId && snapshot ? JSON.stringify([snapshot, row.ticket]) : null
	const latest = useRef<Pending | null>(null)
	latest.current = taskId && snapshot && key ? { taskId, snapshot, row, key } : null
	// What the row holds: the draft as it opened, then each save that landed.
	const saved = useRef<string | null>(null)
	if (saved.current === null && key !== null) saved.current = key
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const inFlight = useRef<Promise<boolean> | null>(null)
	const stopped = useRef(false)

	const clearTimer = () => {
		if (timer.current) clearTimeout(timer.current)
		timer.current = null
	}

	/** Sends one save; resolves to whether it landed. */
	const send = (pending: Pending) => {
		setState('saving')
		const request = (async () => {
			try {
				const result = await api.tasks.saveDraft(
					draftSaveInput({
						taskId: pending.taskId,
						snapshot: pending.snapshot,
						ticket: pending.row.ticket,
						status: pending.row.status,
					}),
					{ context: { silent: true } },
				)
				if (result.result === 'saved') {
					saved.current = pending.key
					setSavedAt(Date.now())
					setState('saved')
					return true
				}
				// Started (no longer a draft) or deleted (archived): a save can't bring it back.
				stopped.current = true
				setState('error')
				showToast(DRAFT_GONE_MESSAGE)
				return false
			} catch {
				// The next edit, or Start, tries again.
				setState('error')
				return false
			}
		})()
		inFlight.current = request
		return request
	}

	/** Saves until the row holds what's on screen; resolves false when a save fails or the draft is gone. */
	const save = async (): Promise<boolean> => {
		clearTimer()
		for (;;) {
			const running = inFlight.current
			if (running) {
				await running
				if (inFlight.current === running) inFlight.current = null
				continue
			}
			const pending = latest.current
			if (stopped.current) return false
			if (!pending || pending.key === saved.current) return true
			const landed = await send(pending)
			inFlight.current = null
			if (!landed) return false
		}
	}

	useEffect(() => {
		if (!key || stopped.current || key === saved.current) return
		timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS)
		return clearTimer
	}, [key])

	useMountEffect(() => () => {
		void save()
	})

	return {
		state,
		/** When this page last saved the draft; null before its first save here. */
		savedAt,
		/** Saves what's pending now; resolves true once the row holds it, false when the save failed. */
		flush: save,
	}
}
