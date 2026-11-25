import z from 'zod/v4'

import { githubTokenErrors } from '../../api/github-accounts/schemas'
import { contractBuilder } from '../../contract-builder'

/** The longest command-output excerpt a daemon may send with a rejection. */
export const GITHUB_REJECTION_EXCERPT_MAX_LENGTH = 2000

const REDACTED = '[redacted]'

/** GitHub token shapes: classic and fine-grained PATs, OAuth, app and refresh tokens. */
const GITHUB_TOKEN_PATTERN = /\b(?:gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g
/** Credentials in a URL: `https://user:secret@github.com/…` keeps only the scheme and host. */
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
/** `Authorization: token …`, `Authorization: Bearer …` and the like, as printed by `gh --verbose` or curl. */
const AUTHORIZATION_PATTERN = /\b(authorization\s*[:=]\s*)(?:(?:token|bearer|basic)\s+)?\S+/gi
/** `oauth_token: …`, `password=…`, `access_token: …` as printed from config files or env dumps. */
const SECRET_ASSIGNMENT_PATTERN = /\b((?:oauth_token|access_token|password|passwd)\s*[:=]\s*)\S+/gi

/**
 * Strip anything that looks like a credential from command output before it leaves the host or is
 * logged: the given secrets verbatim, GitHub token shapes, URL userinfo and authorization headers.
 * Over-redacting is harmless here; the excerpt only explains why a run was stopped.
 */
export function redactGithubSecrets(text: string, secrets: ReadonlyArray<string> = []): string {
	let redacted = text
	for (const secret of secrets) {
		// A short "secret" would redact ordinary words; real tokens are far longer.
		if (secret.length >= 8) redacted = redacted.split(secret).join(REDACTED)
	}
	return redacted
		.replace(GITHUB_TOKEN_PATTERN, REDACTED)
		.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
		.replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
		.replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
}

/** Redact, then cut to the length the procedure accepts. */
export function githubRejectionExcerpt(text: string, secrets: ReadonlyArray<string> = []): string {
	const redacted = redactGithubSecrets(text, secrets)
	return redacted.length <= GITHUB_REJECTION_EXCERPT_MAX_LENGTH
		? redacted
		: `${redacted.slice(0, GITHUB_REJECTION_EXCERPT_MAX_LENGTH - 1)}…`
}

export const GITHUB_REJECTION_REASONS = ['github_token_rejected', 'github_no_repo_access'] as const
export const GithubRejectionReasonSchema = z.enum(GITHUB_REJECTION_REASONS)
export type GithubRejectionReason = z.infer<typeof GithubRejectionReasonSchema>

export const ReportGithubRejectionInputSchema = z.object({
	sessionId: z.uuid(),
	/**
	 * The account the session's credential directory held when the command failed. A rejection for
	 * an account the session no longer resolves to (the user switched meanwhile) is ignored.
	 */
	accountId: z.uuid(),
	/** The failing output around the match, already redacted by the daemon. Never a token. */
	excerpt: z.string().max(GITHUB_REJECTION_EXCERPT_MAX_LENGTH),
})

export const ReportGithubRejectionOutputSchema = z.discriminatedUnion('stop', [
	/**
	 * Stop the run with `reason`. `github_token_rejected`: GitHub answered `GET /user` with 401, and
	 * the account is now marked `needs_token`. `github_no_repo_access`: the token is still valid, so
	 * the account can't reach this repository; it stays `ok`.
	 */
	z.object({ stop: z.literal(true), reason: GithubRejectionReasonSchema, login: z.string().min(1) }),
	/** The session no longer acts as that account (switched, removed, or the host's own gh login). */
	z.object({ stop: z.literal(false) }),
])

export type ReportGithubRejectionOutput = z.infer<typeof ReportGithubRejectionOutputSchema>

/**
 * A daemon saw GitHub refuse a session's account (a `git push` or `gh` call failed with an auth
 * signature). The API is the only judge of what that means: it asks GitHub who the stored token
 * belongs to, marks the account `needs_token` only on a 401, and says whether to stop the run.
 *
 * Scoped like `resolveToken`: the session must be one this daemon's user created on this host,
 * or it is NOT_FOUND. GITHUB_UNREACHABLE when GitHub couldn't be asked; the daemon then lets the
 * run go on, since the failed command already fails as the chosen account and never another.
 */
export const reportGithubRejectionContract = contractBuilder
	.input(ReportGithubRejectionInputSchema)
	.output(ReportGithubRejectionOutputSchema)
	.errors({ GITHUB_UNREACHABLE: githubTokenErrors.GITHUB_UNREACHABLE })
