import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const DeleteTaskInputSchema = z.object({
	taskId: z.uuidv7().describe('The task to delete permanently, with its sessions, conversations and artifacts'),
})

export const DeleteTaskOutputSchema = z.object({
	taskId: z.uuidv7(),
})

/**
 * Permanently delete a task the caller owns. Fails with FORBIDDEN for anyone else's task and
 * NOT_FOUND when it doesn't exist. Nothing on hosts or GitHub is touched.
 */
export const deleteTaskContract = contractBuilder.input(DeleteTaskInputSchema).output(DeleteTaskOutputSchema)
