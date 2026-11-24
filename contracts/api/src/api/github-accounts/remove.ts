import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const RemoveGithubAccountInputSchema = z.object({
	accountId: z.uuid(),
})

/**
 * Delete one of the caller's GitHub accounts and its stored token. Wherever it was the default, the
 * choice falls through to the next level (ultimately the host's own gh login). NOT_FOUND unless the
 * account is the caller's own.
 */
export const removeGithubAccountContract = contractBuilder.input(RemoveGithubAccountInputSchema).output(z.object({}))
