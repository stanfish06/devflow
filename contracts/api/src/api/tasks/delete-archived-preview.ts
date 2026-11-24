import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const DeleteArchivedTasksPreviewInputSchema = z.object({})

export const DeleteArchivedTasksPreviewOutputSchema = z.object({
	/** The caller's own archived tasks, which `tasks.deleteArchived` would delete. */
	deletableCount: z.number().int().nonnegative(),
	/** Archived tasks someone else owns that the caller worked on: listed under Archived, but kept. */
	skippedSharedCount: z.number().int().nonnegative(),
})

export type DeleteArchivedTasksPreview = z.infer<typeof DeleteArchivedTasksPreviewOutputSchema>

/** Count what deleting every archived task the caller owns would remove, for the confirmation. */
export const deleteArchivedTasksPreviewContract = contractBuilder
	.input(DeleteArchivedTasksPreviewInputSchema)
	.output(DeleteArchivedTasksPreviewOutputSchema)
