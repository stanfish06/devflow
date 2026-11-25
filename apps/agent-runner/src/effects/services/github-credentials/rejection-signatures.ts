/**
 * Spotting GitHub refusing a session's account in an agent's command output. Pure, so the list of
 * signatures can be table-tested against real `git` and `gh` output.
 *
 * A match is only a hint: the daemon reports it, and the API decides what it means by asking
 * GitHub about the stored token. So a false match can at worst stop a run with a "no access"
 * notice, never mark a valid token broken. To keep those rare, only commands that call `gh`, or
 * `git` talking to a remote, are scanned; output from `grep`, `cat` and the like never is.
 */

export type GithubRejectionSignature =
	| 'permission_denied'
	| 'authentication_failed'
	| 'bad_credentials'
	| 'http_401'
	| 'repository_not_found'

export interface GithubRejectionMatch {
	readonly signature: GithubRejectionSignature
	/** The login GitHub says it refused (`… denied to <login>`), when the output names one. */
	readonly login: string | null
	/**
	 * The lines around the match, as the command printed them. Not cut to length here: redact it
	 * first (`githubRejectionExcerpt`), so a cut can never leave part of a token behind.
	 */
	readonly excerpt: string
}

// `git` or `gh` as a command word: at the start, after a separator, or as a path's last segment.
const GIT_COMMAND = /(?:^|[\s;&|(`'"/])git(?=\s)/m
const GH_COMMAND = /(?:^|[\s;&|(`'"/])gh(?=\s)/m
// The git subcommands that talk to a remote and so carry the account's credentials.
const GIT_REMOTE_SUBCOMMAND = /(?:^|\s)(?:push|pull|fetch|clone|ls-remote)(?=\s|$)/m
const GIT_PUSH = /(?:^|\s)push(?=\s|$)/m

const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, 'g')

const EXCERPT_CONTEXT_LINES = 2

interface Signature {
	readonly signature: GithubRejectionSignature
	readonly pattern: RegExp
	/** Only a push counts: `Repository not found` on a clone or fetch is just a wrong URL. */
	readonly pushOnly?: boolean
}

// Most specific first: a match that names the refused login wins.
const SIGNATURES: readonly Signature[] = [
	// remote: Permission to acme/api.git denied to stan-work.
	{
		signature: 'permission_denied',
		pattern: /Permission to \S+ denied to ([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/,
	},
	// fatal: Authentication failed for 'https://github.com/acme/api.git/'
	{
		signature: 'authentication_failed',
		pattern: /Authentication failed for '?https:\/\/(?:[^\s@'/]+@)?github\.com\//,
	},
	// gh: HTTP 401: Bad credentials (https://api.github.com/graphql)
	{ signature: 'bad_credentials', pattern: /\bBad credentials\b/ },
	{ signature: 'http_401', pattern: /\bHTTP 401\b/ },
	// remote: Repository not found.  (GitHub's answer to a push the token may not make)
	{ signature: 'repository_not_found', pattern: /\bRepository not found\b/, pushOnly: true },
]

/** Whether a shell command reaches GitHub with the session's credentials: `gh`, or `git` on a remote. */
export function talksToGithub(command: string): boolean {
	return GH_COMMAND.test(command) || (GIT_COMMAND.test(command) && GIT_REMOTE_SUBCOMMAND.test(command))
}

/**
 * The first GitHub auth-failure signature in a command's output, or null. Commands that don't call
 * `gh` or `git` on a remote never match, whatever they print.
 */
export function matchGithubRejection(input: {
	readonly command: string
	readonly output: string
}): GithubRejectionMatch | null {
	const { command } = input
	if (!talksToGithub(command)) return null
	const output = input.output.replace(ANSI_ESCAPE, '')
	const pushes = GIT_COMMAND.test(command) && GIT_PUSH.test(command)
	for (const { signature, pattern, pushOnly } of SIGNATURES) {
		if (pushOnly && !pushes) continue
		const found = pattern.exec(output)
		if (found === null) continue
		return {
			signature,
			login: signature === 'permission_denied' ? (found[1] ?? null) : null,
			excerpt: excerptAround(output, found.index),
		}
	}
	return null
}

/** The matched line with a little context either side. */
function excerptAround(output: string, index: number): string {
	const lines = output.split('\n')
	let offset = 0
	let matchLine = 0
	for (const [lineNumber, line] of lines.entries()) {
		if (offset + line.length >= index) {
			matchLine = lineNumber
			break
		}
		offset += line.length + 1
	}
	return lines
		.slice(Math.max(0, matchLine - EXCERPT_CONTEXT_LINES), matchLine + EXCERPT_CONTEXT_LINES + 1)
		.join('\n')
		.trim()
}
