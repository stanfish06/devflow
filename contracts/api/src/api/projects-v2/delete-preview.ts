import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const ProjectDeletePreviewInputSchema = z.object({
	projectId: z.uuid(),
})

export const ProjectDeletePreviewOutputSchema = z.object({
	/** Every task a delete would take with the project, archived ones and teammates' private ones included. */
	taskCount: z.number().int().nonnegative(),
	/** How many of those tasks belong to someone other than the caller. */
	otherPeoplesTaskCount: z.number().int().nonnegative(),
})

export type ProjectDeletePreview = z.infer<typeof ProjectDeletePreviewOutputSchema>

/**
 * Count what deleting a project would remove, for its owner's confirmation. The count comes from the
 * server because the owner's browser never syncs teammates' private tasks. Fails with FORBIDDEN for
 * anyone but the owner and NOT_FOUND when the project doesn't exist.
 */
export const projectDeletePreviewV2Contract = contractBuilder
	.input(ProjectDeletePreviewInputSchema)
	.output(ProjectDeletePreviewOutputSchema)
