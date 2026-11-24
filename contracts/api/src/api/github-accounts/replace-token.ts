import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { GithubAccountSchema, githubTokenErrors, GithubTokenInputSchema } from './schemas'

export const ReplaceGithubAccountTokenInputSchema = z.object({
	accountId: z.uuid(),
	token: GithubTokenInputSchema,
})

export const ReplaceGithubAccountTokenOutputSchema = z.object({
	account: GithubAccountSchema,
})

/**
 * Swap an account's token for a new one, keeping its place as a default anywhere it is one. The new
 * token must belong to the same GitHub user (BAD_REQUEST otherwise, or when GitHub rejects it), and
 * the account's status returns to `ok`. NOT_FOUND unless the account is the caller's own.
 */
export const replaceGithubAccountTokenContract = contractBuilder
	.input(ReplaceGithubAccountTokenInputSchema)
	.output(ReplaceGithubAccountTokenOutputSchema)
	.errors(githubTokenErrors)
