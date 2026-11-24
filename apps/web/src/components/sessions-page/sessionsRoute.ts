import z from 'zod/v4'

/**
 * Search params for the tasks/sessions list. `kanban` has no producer; it is
 * accepted so old bookmarks still validate and fall through to `tasks`.
 */
export const sessionsSearchSchema = z.object({
	task: z.string().optional(),
	tab: z.enum(['tasks', 'kanban', 'sessions', 'drafts', 'context-shards']).optional(),
})

export type SessionsRouteTab = z.infer<typeof sessionsSearchSchema>['tab']
export type SessionsRouteTo = '/' | '/sessions'
