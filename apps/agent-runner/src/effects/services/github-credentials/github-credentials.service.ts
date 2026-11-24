import { Context, Data, type Effect } from 'effect'

import type { GithubEnv } from './credential-files'

export type { GithubEnv } from './credential-files'

/**
 * Where the agent runs, which decides what its gitconfig may include: on the host it keeps the
 * user's own global git config underneath the account's settings; in the Docker sandbox it can't
 * see that config, so it gets only the account's.
 */
export type GithubCredentialScope = 'host' | 'sandbox'

export interface PrepareGithubCredentialsInput {
	readonly sessionId: string
	readonly taskId: string | null
	readonly scope: GithubCredentialScope
}

/**
 * The session's GitHub account couldn't be put in place. The session must not start: running it
 * under the host's own login instead would push and open PRs as the wrong account. Never carries
 * the token.
 */
export class GithubCredentialsError extends Data.TaggedError('GithubCredentialsError')<{
	readonly sessionId: string
	readonly reason: 'resolve' | 'invalid' | 'write'
	readonly message: string
	readonly cause?: unknown
}> {}

export interface GithubCredentialsService {
	/**
	 * Ask the API which account the session acts as and write its credential directory. Returns the
	 * env that points `gh` and `git` at it, or null when the session keeps the host's own gh login
	 * (nothing is written, and the agent's env must stay exactly as it is).
	 *
	 * Every successful non-null prepare must be paired with one `release`.
	 */
	readonly prepare: (input: PrepareGithubCredentialsInput) => Effect.Effect<GithubEnv | null, GithubCredentialsError>
	/** Drop one hold on the session's directory; the last one removes it from disk. Never fails. */
	readonly release: (sessionId: string) => Effect.Effect<void>
}

/**
 * Owns every session's GitHub credential directory on this host (`~/.devflow/run/<sessionId>/github`):
 * writes it when a session starts, and removes it when the session ends or the daemon stops.
 */
export class GithubCredentials extends Context.Service<GithubCredentials, GithubCredentialsService>()(
	'GithubCredentials',
) {}
