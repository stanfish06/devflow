import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { GithubAccountSchema } from './schemas'

export const ListGithubAccountsOutputSchema = z.object({
	accounts: z.array(GithubAccountSchema),
	/** The account agents use when the task and project don't pick one; null is the host's own gh login. */
	defaultAccountId: z.uuid().nullable(),
	/** The caller's own default account per project, by project id; projects without one are absent. */
	projectDefaults: z.record(z.string(), z.uuid()),
})

/**
 * The caller's own GitHub accounts in this organization, oldest first, which is their default, and
 * which account each of their projects defaults to.
 */
export const listGithubAccountsContract = contractBuilder
	.input(z.object({}).optional())
	.output(ListGithubAccountsOutputSchema)
