import { useTaskDiffReviewMarksStore } from '@/hooks/stores/taskDiffReviewMarksStore'
import { showUndoToast } from '@/utils/undoToast'

import type { createTaskActions } from './tasks'

export interface ArchiveTaskWithCleanupParams {
	taskActions: ReturnType<typeof createTaskActions>
	taskId: string
	/** Task name, shown in the undo toast. */
	taskName: string
	/** Target archived state (`true` archives, `false` un-archives). */
	archived: boolean
	/** Non-archived session ids to cascade the (un)archive to. */
	sessionIds: string[]
}

/**
 * Archive (or un-archive) a task with the full side-effect bundle that has to
 * accompany it everywhere: the optimistic `archiveTask` action with session
 * cascade, cleanup of the task's saved diff review marks (archive direction
 * only), and an undo toast that reverses the operation.
 *
 * Shared by the task table, the kanban board, and any other surface that
 * archives a task.
 * Callers own any focus-movement that should follow the archive.
 */
export function archiveTaskWithCleanup({
	taskActions,
	taskId,
	taskName,
	archived,
	sessionIds,
}: ArchiveTaskWithCleanupParams): void {
	taskActions.archiveTask({ taskId, archived, cascadeToSessions: true, sessionIds })

	if (archived) {
		useTaskDiffReviewMarksStore.getState().clearTask(taskId)
	}

	const sessionCount = sessionIds.length
	const sessionSuffix = sessionCount > 0 ? ` + ${sessionCount} session${sessionCount !== 1 ? 's' : ''}` : ''

	showUndoToast({
		type: archived ? 'archive_task' : 'unarchive_task',
		entityId: taskId,
		title: archived ? 'Task Archived' : 'Task Un-archived',
		description: `${taskName}${sessionSuffix}`,
		onUndo: () => {
			taskActions.archiveTask({ taskId, archived: !archived, cascadeToSessions: true, sessionIds })
		},
	})
}
