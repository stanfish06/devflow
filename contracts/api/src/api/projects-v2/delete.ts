import { StatusCodes } from 'http-status-codes'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const DeleteProjectInputSchema = z.object({
	projectId: z.uuid(),
	/** The task count the owner confirmed, from `projects.v2.deletePreview`. */
	expectedTaskCount: z.number().int().nonnegative(),
})

export const DeleteProjectOutputSchema = z.object({
	deletedTaskCount: z.number().int().nonnegative(),
})

/**
 * Permanently delete a project the caller owns, with every one of its tasks (archived and teammates'
 * included). The server re-counts the tasks under a row lock and fails with COUNT_CHANGED when the
 * number differs from `expectedTaskCount`, so the confirmation can never understate what goes.
 * Fails with FORBIDDEN for anyone but the owner and NOT_FOUND when the project doesn't exist.
 * Nothing on hosts or GitHub is touched.
 */
export const deleteProjectV2Contract = contractBuilder
	.input(DeleteProjectInputSchema)
	.output(DeleteProjectOutputSchema)
	.errors({
		COUNT_CHANGED: {
			status: StatusCodes.CONFLICT,
			data: z.object({
				expected: z.number().int().nonnegative(),
				actual: z.number().int().nonnegative(),
			}),
		},
	})
