import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const SetDefaultGithubAccountInputSchema = z.object({
	/** One of the caller's accounts, or null for the host's own gh login. */
	accountId: z.uuid().nullable(),
})

/**
 * Choose the account the caller's agents act as when neither the task nor its project picks one.
 * NOT_FOUND unless the account is the caller's own.
 */
export const setDefaultGithubAccountContract = contractBuilder
	.input(SetDefaultGithubAccountInputSchema)
	.output(z.object({}))
