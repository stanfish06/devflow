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

/**
 * What a refresh did for one live session of the task.
 *
 * - `applied`: the agent acts as the task's new choice from its next `git` or `gh` call. Either its
 *   credential files now hold the new account, or it keeps the host's own gh login it started with.
 * - `restart`: the new choice can't reach the running agent. Whether an agent uses a credential
 *   directory at all is fixed in its environment when it starts, so a switch between an account
 *   and the host's own gh login (either way) only applies once the agent restarts. Until then a
 *   directory that held an account is locked: GitHub access fails rather than going out as the
 *   account the user just switched away from. The same holds when the new choice can't be read.
 */
export interface GithubCredentialsRefresh {
	readonly sessionId: string
	readonly outcome: 'applied' | 'restart'
}

export interface GithubCredentialsService {
	/**
	 * Ask the API which account the session acts as and write its credential directory. Returns the
	 * env that points `gh` and `git` at it, or null when the session keeps the host's own gh login
	 * (nothing is written, and the agent's env must stay exactly as it is).
	 *
	 * Every successful prepare, null or not, must be paired with one `release`: the service tracks
	 * host-login sessions too, so a later switch to an account knows their agent must restart.
	 */
	readonly prepare: (input: PrepareGithubCredentialsInput) => Effect.Effect<GithubEnv | null, GithubCredentialsError>
	/**
	 * The task's GitHub account changed: ask the API again for each of its sessions prepared on this
	 * host, and bring their credential directories in line. Never fails; a session whose new choice
	 * can't be read is locked and reported as `restart`.
	 */
	readonly refresh: (taskId: string) => Effect.Effect<ReadonlyArray<GithubCredentialsRefresh>>
	/** Drop one hold on the session; the last one removes its directory from disk. Never fails. */
	readonly release: (sessionId: string) => Effect.Effect<void>
}

/**
 * Owns every session's GitHub credential directory on this host (`~/.devflow/run/<sessionId>/github`):
 * writes it when a session starts, rewrites it when the task's account changes mid-run, and removes
 * it when the session ends or the daemon stops.
 */
export class GithubCredentials extends Context.Service<GithubCredentials, GithubCredentialsService>()(
	'GithubCredentials',
) {}
