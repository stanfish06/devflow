import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import type { TableSession } from '@/components/session-table/types'
import { useTaskDiffReviewMarksStore } from '@/hooks/stores/taskDiffReviewMarksStore'
import type { TaskDetailTask } from '@/hooks/task-detail/useTaskDetailData'
import { useTaskActions } from '@/hooks/useTaskActions'
import { showUndoToast } from '@/utils/undoToast'

/**
 * Archive/unarchive for the task detail page: cascades to the task's
 * sessions and their diff review marks, shows an undo toast, and
 * navigates back to the tasks list after archiving.
 */
export function useTaskArchive({ task, sessions }: { task: TaskDetailTask | undefined; sessions: TableSession[] }) {
	const navigate = useNavigate()
	const taskActions = useTaskActions()

	const handleArchiveTask = useCallback(() => {
		if (!task) return
		const isArchived = task.archived ?? false
		const newArchivedState = !isArchived

		const sessionIds = sessions.map((s) => s.id)
		const sessionCount = sessionIds.length

		taskActions.archiveTask({
			taskId: task.id,
			archived: newArchivedState,
			cascadeToSessions: true,
			sessionIds,
		})

		if (newArchivedState) {
			useTaskDiffReviewMarksStore.getState().clearTask(task.id)
		}

		const sessionSuffix = sessionCount > 0 ? ` + ${sessionCount} session${sessionCount !== 1 ? 's' : ''}` : ''

		showUndoToast({
			type: newArchivedState ? 'archive_task' : 'unarchive_task',
			entityId: task.id,
			title: newArchivedState ? 'Task Archived' : 'Task Un-archived',
			description: `${task.name}${sessionSuffix}`,
			onUndo: () => {
				taskActions.archiveTask({
					taskId: task.id,
					archived: !newArchivedState,
					cascadeToSessions: true,
					sessionIds,
				})
			},
		})

		if (newArchivedState) {
			navigate({ to: '/sessions' })
		}
	}, [task, sessions, taskActions, navigate])

	return { handleArchiveTask }
}
