import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const SetTaskGithubAccountInputSchema = z.object({
	taskId: z.uuidv7(),
	/** One of the caller's accounts, or null for each host's own gh login. */
	accountId: z.uuid().nullable(),
})

/**
 * Choose the GitHub account the caller's agents act as in one task, over the project's default and
 * their own. Per person: a teammate's sessions on the same task keep their own choice. NOT_FOUND
 * unless the caller can read the task and the account is the caller's own.
 */
export const setTaskGithubAccountContract = contractBuilder.input(SetTaskGithubAccountInputSchema).output(z.object({}))
