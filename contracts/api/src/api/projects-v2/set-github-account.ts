import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const SetProjectGithubAccountInputSchema = z.object({
	projectId: z.uuid(),
	/** One of the caller's accounts, or null for no project default (the caller's own default applies). */
	accountId: z.uuid().nullable(),
})

/**
 * Choose the GitHub account the caller's agents act as in this project's tasks, unless a task picks
 * its own. Per person: each member of a shared project picks from their own accounts. NOT_FOUND
 * unless the caller can read the project and the account is the caller's own.
 */
export const setProjectGithubAccountContract = contractBuilder
	.input(SetProjectGithubAccountInputSchema)
	.output(z.object({}))
