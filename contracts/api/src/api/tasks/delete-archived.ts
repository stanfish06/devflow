import { StatusCodes } from 'http-status-codes'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const DeleteArchivedTasksInputSchema = z.object({
	/** The count the caller confirmed, from `tasks.deleteArchivedPreview`. */
	expectedCount: z.number().int().nonnegative(),
})

export const DeleteArchivedTasksOutputSchema = z.object({
	deletedCount: z.number().int().nonnegative(),
})

/**
 * Permanently delete every archived task the caller owns, with their sessions, conversations and
 * artifacts. Archived tasks owned by anyone else are never touched. The server re-counts under row
 * locks and fails with COUNT_CHANGED when the number differs from `expectedCount`, so the
 * confirmation can never understate what goes. Nothing on hosts or GitHub is touched.
 */
export const deleteArchivedTasksContract = contractBuilder
	.input(DeleteArchivedTasksInputSchema)
	.output(DeleteArchivedTasksOutputSchema)
	.errors({
		COUNT_CHANGED: {
			status: StatusCodes.CONFLICT,
			data: z.object({
				expected: z.number().int().nonnegative(),
				actual: z.number().int().nonnegative(),
			}),
		},
	})
