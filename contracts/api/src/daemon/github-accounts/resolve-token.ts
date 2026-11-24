import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const ResolveGithubTokenInputSchema = z.object({
	sessionId: z.uuid(),
})

/** The account a session's agent acts as, with its token in plain text. */
export const ResolvedGithubAccountSchema = z.object({
	accountId: z.uuid(),
	login: z.string().min(1),
	/** GitHub display name, the commit author name; null when the profile has none. */
	name: z.string().nullable(),
	/** `{id}+{login}@users.noreply.github.com`, the commit author email. */
	email: z.string().min(1),
	token: z.string().min(1),
})

/** No account is chosen: the agent keeps using the host's own gh login and git identity. */
export const UseHostLoginSchema = z.object({
	useHostLogin: z.literal(true),
})

export const ResolveGithubTokenOutputSchema = z.union([ResolvedGithubAccountSchema, UseHostLoginSchema])

export type ResolveGithubTokenOutput = z.infer<typeof ResolveGithubTokenOutputSchema>

/**
 * Which GitHub account a session's agent acts as, and its token. The only procedure that returns a
 * token. The session must have been created by the calling daemon's user, in its organization, on
 * its host; anything else is NOT_FOUND, so a daemon can never obtain another user's token.
 *
 * SERVICE_UNAVAILABLE when the server can't decrypt tokens (no usable GITHUB_ACCOUNT_TOKEN_KEY).
 * The daemon must not fall back to the host's login on any failure.
 */
export const resolveGithubTokenContract = contractBuilder
	.input(ResolveGithubTokenInputSchema)
	.output(ResolveGithubTokenOutputSchema)
