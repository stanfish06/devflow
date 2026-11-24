import { useNavigate } from '@tanstack/react-router'

import { useOpenTaskId } from '@/minimalist/lib/data'
import { useUi } from '@/minimalist/lib/ui-state'
import { useAction } from '@/minimalist/lib/use-action'
import { useApi } from '@/orpc/client'

/** What a delete confirmation is about. Later targets (projects, archived tasks) widen this. */
export type DeleteTarget = { kind: 'task'; taskId: string; title: string }

export type DeleteOutcome = 'deleted' | 'failed'

/**
 * Permanently delete what the target names. Unlike `useArchive` there is no Undo: the toast only
 * confirms. Sync removes the rows everywhere, so the UI isn't updated by hand. A failure is kept in
 * `error` for the confirmation dialog to show, because its backdrop covers toasts.
 */
export function useDelete() {
	const { client: api } = useApi()
	const { showToast } = useUi()
	const navigate = useNavigate()
	const openTaskId = useOpenTaskId()
	const action = useAction('inline')

	const remove = async (target: DeleteTarget): Promise<DeleteOutcome> => {
		const deleted = await action.run(
			() => api.tasks.delete({ taskId: target.taskId }),
			'Could not delete the task. Try again.',
		)
		if (!deleted) return 'failed'
		// Leave the page before sync takes the task out from under it.
		if (openTaskId === target.taskId) void navigate({ to: '/' })
		showToast('Task deleted')
		return 'deleted'
	}

	return { remove, pending: action.pending, error: action.error }
}
