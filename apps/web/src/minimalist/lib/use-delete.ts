import { isDefinedError, ORPCError } from '@orpc/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { useOpenTaskId } from '@/minimalist/lib/data'
import { useUi } from '@/minimalist/lib/ui-state'
import { useAction } from '@/minimalist/lib/use-action'
import { useApi } from '@/orpc/client'
import { invalidateProjectsV2 } from '@/queries/projects-v2'

/** What a delete confirmation is about. Archived tasks in bulk widen this next. */
export type DeleteTarget =
	| { kind: 'task'; taskId: string; title: string }
	| { kind: 'project'; projectId: string; name: string }

/** What a project delete takes with it, counted on the server. */
export type ProjectDeletePreview = { taskCount: number; otherPeoplesTaskCount: number }

/** `count-changed`: the server counted different tasks than the confirmation showed, and deleted nothing. */
export type DeleteOutcome = 'deleted' | 'count-changed' | 'failed'

type ApiQueries = ReturnType<typeof useApi>['queryClient']

/**
 * The server's count of what deleting a project takes. Only the owner may ask, so it is silent: a
 * failure shows in the dialog that asked, not as a toast behind it.
 */
export function projectDeletePreviewQuery(api: ApiQueries, projectId: string) {
	return api.projects.v2.deletePreview.queryOptions({ input: { projectId }, context: { silent: true } })
}

export function useProjectDeletePreview(projectId: string) {
	const { queryClient: api } = useApi()
	return useQuery(projectDeletePreviewQuery(api, projectId))
}

const COUNT_CHANGED_COPY = 'Its tasks changed since this opened. Check the new count, then delete again.'

function isCountChanged(error: unknown): boolean {
	return error instanceof ORPCError && isDefinedError(error) && error.code === 'COUNT_CHANGED'
}

/**
 * Permanently delete what the target names. Unlike `useArchive` there is no Undo: the toast only
 * confirms. Sync removes tasks and sessions everywhere, so those aren't updated by hand; projects
 * come from a query, which is refreshed. A failure is kept in `error` for the confirmation dialog to
 * show, because its backdrop covers toasts.
 *
 * A project delete carries the task count the owner confirmed. When the server counts differently
 * it deletes nothing and the outcome is `count-changed`, for the dialog to count again.
 */
export function useDelete() {
	const { client: api } = useApi()
	const queryClient = useQueryClient()
	const { showToast } = useUi()
	const navigate = useNavigate()
	const openTaskId = useOpenTaskId()
	const action = useAction('inline')

	const removeTask = async (target: Extract<DeleteTarget, { kind: 'task' }>): Promise<DeleteOutcome> => {
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

	const removeProject = async (
		target: Extract<DeleteTarget, { kind: 'project' }>,
		expectedTaskCount: number,
	): Promise<DeleteOutcome> => {
		const failure = { countChanged: false }
		const deleted = await action.run(
			() =>
				api.projects.v2.delete(
					{ projectId: target.projectId, expectedTaskCount },
					{ context: { silent: true } },
				),
			(error) => {
				failure.countChanged = isCountChanged(error)
				return failure.countChanged ? COUNT_CHANGED_COPY : `Could not delete ${target.name}. Try again.`
			},
		)
		if (!deleted) return failure.countChanged ? 'count-changed' : 'failed'
		// Projects aren't synced: refetch the lists so the sidebar and Archived page drop it now.
		void invalidateProjectsV2(queryClient)
		showToast(`${target.name} deleted`)
		return 'deleted'
	}

	const remove = (target: DeleteTarget, expected?: number): Promise<DeleteOutcome> => {
		switch (target.kind) {
			case 'task':
				return removeTask(target)
			case 'project':
				// The dialog only offers Delete once the preview has counted.
				return expected === undefined ? Promise.resolve('failed') : removeProject(target, expected)
		}
	}

	return { remove, pending: action.pending, error: action.error }
}
