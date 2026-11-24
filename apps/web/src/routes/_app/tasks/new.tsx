import { createFileRoute, redirect } from '@tanstack/react-router'
import z from 'zod/v4'

const newTaskSearchSchema = z.object({
	// Preselects the project the new task starts in.
	projectId: z.uuid().optional().catch(undefined),
	// Opens the composer on an existing draft task.
	draftId: z.string().optional(),
})

/** New tasks start from the home composer; this path keeps older links working. */
export const Route = createFileRoute('/_app/tasks/new')({
	validateSearch: newTaskSearchSchema,
	beforeLoad: ({ search }) => {
		throw redirect({
			to: '/',
			search: { project: search.projectId, task: search.draftId },
			replace: true,
		})
	},
})
