import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import z from 'zod/v4'

import { DesktopTaskDetailPage } from '@/components/task-detail/DesktopTaskDetailPage'
import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { optionalBooleanSearchParam } from '@/lib/search-params'
import { MinimalistTaskPage } from '@/minimalist/components/TaskPage'
import { useTask } from '@/minimalist/lib/data'

export const taskDetailSearchSchema = z.object({
	session: z.string().optional(),
	view: z.literal('changes').optional(),
	pr: optionalBooleanSearchParam,
	from: z.enum(['archive-tasks']).optional(),
	artifactId: z.string().optional(),
	commentId: z.string().optional(),
	/** V2 comment deep link: one-shot reveal of a root/reply ID (with artifactId). */
	comment: z.string().optional(),
	headingId: z.string().optional(),
	focus: z.literal('workspace').optional(),
	/** With artifactId: open the artifact viewer fullscreen on load. */
	fullscreen: optionalBooleanSearchParam,
	diffFileId: z.string().optional(),
	diffCommentId: z.string().optional(),
	diffPresentation: z.enum(['sidebar', 'primary', 'fullscreen']).optional(),
	deep: z.boolean().optional(),
})

export const Route = createFileRoute('/_app/tasks/$taskId')({
	validateSearch: taskDetailSearchSchema,
	component: TaskDetailPage,
	loader: ({ params, context, location }) => {
		// Skip preloading for archived tasks (from archive pages)
		const searchParams = new URLSearchParams(location.search)
		const isFromArchive = searchParams.get('from') === 'archive-tasks'
		context.preloadService?.preloadTaskDetail(params.taskId, isFromArchive)
	},
})

function TaskDetailPage() {
	const minimalist = useMinimalistLayout()
	const { taskId } = Route.useParams()
	const { session } = Route.useSearch()
	if (minimalist) return <MinimalistTaskRoute key={taskId} taskId={taskId} sessionId={session} />
	return <StandardTaskDetailPage />
}

/**
 * The task page, until sync drops a task this page was showing: it was deleted, here or in another
 * browser, so a plain page says so instead of an empty task. A task never seen here (a stale link,
 * or one sync hasn't delivered yet) keeps the task page's own "doesn't exist" state, since without
 * tombstones the browser can't tell those apart.
 */
function MinimalistTaskRoute({ taskId, sessionId }: { taskId: string; sessionId?: string }) {
	const { task, isReady } = useTask(taskId)
	const [seen, setSeen] = useState(false)
	if (task && !seen) setSeen(true)
	if (seen && isReady && !task)
		return (
			<main className="main">
				<div className="hero">
					<h1 className="status">This task was deleted</h1>
				</div>
			</main>
		)
	return <MinimalistTaskPage taskId={taskId} sessionId={sessionId} />
}

function StandardTaskDetailPage() {
	const { taskId } = Route.useParams()
	const { from, artifactId, commentId, fullscreen, focus, diffFileId, diffCommentId, diffPresentation } =
		Route.useSearch()
	return (
		<DesktopTaskDetailPage
			key={taskId}
			taskId={taskId}
			from={from}
			searchArtifactId={artifactId ?? null}
			searchCommentId={commentId ?? null}
			searchFullscreen={fullscreen ?? null}
			searchDiff={{
				diffFileId: diffFileId ?? null,
				diffCommentId: diffCommentId ?? null,
				diffPresentation: diffPresentation ?? null,
			}}
			searchFocus={focus}
		/>
	)
}
