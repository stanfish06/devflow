import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { GithubAccountSchema, githubTokenErrors, GithubTokenInputSchema } from './schemas'

export const AddGithubAccountInputSchema = z.object({
	token: GithubTokenInputSchema,
})

export const AddGithubAccountOutputSchema = z.object({
	account: GithubAccountSchema,
})

/**
 * Check a personal access token with GitHub (`GET /user`) and store it, encrypted, under the GitHub
 * login it belongs to. Adding an account the caller already has replaces its token. Fails with
 * BAD_REQUEST when GitHub rejects the token. The token is never returned.
 */
export const addGithubAccountContract = contractBuilder
	.input(AddGithubAccountInputSchema)
	.output(AddGithubAccountOutputSchema)
	.errors(githubTokenErrors)
