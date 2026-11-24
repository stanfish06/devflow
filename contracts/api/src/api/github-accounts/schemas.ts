import { StatusCodes } from 'http-status-codes'
import z from 'zod/v4'

/**
 * A GitHub account the caller's agents can push and open pull requests as. Never carries the token:
 * only the daemon's own procedure ever returns one.
 */
export const GithubAccountSchema = z.object({
	id: z.uuid(),
	login: z.string(),
	/** GitHub display name, used as the commit author name; null when the profile has none. */
	name: z.string().nullable(),
	/** `{id}+{login}@users.noreply.github.com`, used as the commit author email. */
	noreplyEmail: z.string(),
	/** `needs_token`: GitHub rejected the stored token, and it must be replaced before agents can use it. */
	status: z.enum(['ok', 'needs_token']),
	createdAt: z.number().int().nonnegative(),
})

export type GithubAccount = z.infer<typeof GithubAccountSchema>

/** A personal access token as pasted. Trimmed; never echoed back or logged. */
export const GithubTokenInputSchema = z.string().trim().min(1).max(1024)

/**
 * The failures specific to checking a pasted token with GitHub and storing it. A token GitHub
 * rejects, or one for a different account than the one being replaced, is BAD_REQUEST.
 */
export const githubTokenErrors = {
	/** GitHub couldn't be reached, or answered with something other than a user. */
	GITHUB_UNREACHABLE: {
		status: StatusCodes.BAD_GATEWAY,
		data: z.object({ message: z.string() }),
	},
	/** The server has no usable GITHUB_ACCOUNT_TOKEN_KEY, so it can't store tokens. */
	TOKEN_STORAGE_UNAVAILABLE: {
		status: StatusCodes.SERVICE_UNAVAILABLE,
		data: z.object({ message: z.string() }),
	},
} as const
