import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { Config, Effect, Layer, Option, Redacted, Semaphore } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { DaemonApi } from '../daemon-api/daemon-api.service'
import {
	credentialPaths,
	credentialProblem,
	githubEnvFor,
	hostGlobalGitConfigPaths,
	isCredentialSessionId,
	renderGhConfigYml,
	renderGhHostsYml,
	renderGitconfig,
	renderLockedGhHostsYml,
	renderLockedGitconfig,
	renderTokenFile,
	type CredentialPaths,
	type GithubAccountCredentials,
} from './credential-files'
import {
	GithubCredentials,
	GithubCredentialsError,
	type GithubCredentialScope,
	type GithubCredentialsRefresh,
	type GithubCredentialsService,
	type PrepareGithubCredentialsInput,
} from './github-credentials.service'

const PRIVATE_DIRECTORY = 0o700
const PRIVATE_FILE = 0o600

/** A session prepared on this host, and how many of its runs still hold it. */
interface CredentialEntry {
	readonly taskId: string | null
	/** Where the session's agent runs, which decides what its gitconfig may include. */
	scope: GithubCredentialScope
	/**
	 * How the session's latest run started: pointed at the credential directory (`account`), or with
	 * the host's own gh login and the env untouched (`host`). Fixed for that run's lifetime.
	 */
	mode: 'account' | 'host'
	/** The credential directory, once one has been written; removed with the last hold. */
	paths: CredentialPaths | null
	holds: number
}

export interface GithubCredentialsOptions {
	/** Parent of every session's directory: `~/.devflow/run`. */
	readonly runDirectory: string
	/** The host user's own global git config files, included under a non-sandboxed agent's gitconfig. */
	readonly hostGitConfigPaths: readonly string[]
}

/**
 * Build the service. The map of prepared sessions is what a task-level account switch walks to
 * rewrite their directories; the semaphore keeps a session's writes and removal from interleaving.
 */
export const makeGithubCredentials = Effect.fn('github_credentials.make')(function* (
	options: GithubCredentialsOptions,
) {
	const api = yield* DaemonApi
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = new Map<string, CredentialEntry>()
	const lock = yield* Semaphore.make(1)

	const includePathsFor = (scope: GithubCredentialScope) => (scope === 'host' ? options.hostGitConfigPaths : [])

	const privateDirectory = (directory: string) =>
		fs
			.makeDirectory(directory, { recursive: true, mode: PRIVATE_DIRECTORY })
			// `mode` only applies to directories this call creates; tighten one that already existed.
			.pipe(Effect.andThen(fs.chmod(directory, PRIVATE_DIRECTORY)))

	/** Write through a fresh private temp file and rename it over the target, so readers never see half. */
	const writePrivateFile = (target: string, contents: string) =>
		Effect.gen(function* () {
			const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
			yield* fs.writeFileString(temporary, contents, { flag: 'wx', mode: PRIVATE_FILE }).pipe(
				Effect.andThen(fs.chmod(temporary, PRIVATE_FILE)),
				Effect.andThen(fs.rename(temporary, target)),
				Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
			)
		})

	const writeCredentialFiles = (
		paths: CredentialPaths,
		account: GithubAccountCredentials,
		scope: GithubCredentialScope,
	) =>
		Effect.gen(function* () {
			yield* privateDirectory(options.runDirectory)
			yield* privateDirectory(paths.sessionDirectory)
			yield* privateDirectory(paths.directory)
			yield* privateDirectory(paths.ghConfigDirectory)
			yield* writePrivateFile(paths.tokenFile, renderTokenFile(account))
			yield* writePrivateFile(paths.ghHostsFile, renderGhHostsYml(account))
			yield* writePrivateFile(paths.ghConfigFile, renderGhConfigYml())
			yield* writePrivateFile(
				paths.gitconfigFile,
				renderGitconfig({ account, tokenFile: paths.tokenFile, includePaths: includePathsFor(scope) }),
			)
		})

	/**
	 * Close GitHub access for an agent still pointed at the directory: no token, gh logged out, and
	 * git refusing every credential request. If the files can't be rewritten, the token and gh login
	 * are deleted instead, so the account never stays usable.
	 */
	const lockCredentialFiles = (sessionId: string, paths: CredentialPaths, scope: GithubCredentialScope) =>
		Effect.gen(function* () {
			yield* writePrivateFile(paths.tokenFile, '')
			yield* writePrivateFile(paths.ghHostsFile, renderLockedGhHostsYml())
			yield* writePrivateFile(
				paths.gitconfigFile,
				renderLockedGitconfig({ includePaths: includePathsFor(scope) }),
			)
		}).pipe(
			Effect.catch((error) =>
				Effect.logError('Could not lock a session GitHub credential directory; deleting its token').pipe(
					Effect.annotateLogs({ sessionId, error: error.message }),
					Effect.andThen(
						Effect.forEach(
							[paths.tokenFile, paths.ghHostsFile],
							(file) =>
								fs
									.remove(file, { force: true })
									.pipe(
										Effect.catch((removeError) =>
											Effect.logError('Could not delete a session GitHub credential file').pipe(
												Effect.annotateLogs({ sessionId, file, error: removeError.message }),
											),
										),
									),
							{ discard: true },
						),
					),
				),
			),
		)

	const removeSessionDirectory = (sessionId: string, paths: CredentialPaths) =>
		fs
			.remove(paths.sessionDirectory, { recursive: true, force: true })
			.pipe(
				Effect.catch((error) =>
					Effect.logError('Could not remove a session GitHub credential directory').pipe(
						Effect.annotateLogs({ sessionId, error: error.message }),
					),
				),
			)

	/** The account the session acts as according to the API, or null for the host's own gh login. */
	const resolveAccount = (sessionId: string) =>
		Effect.gen(function* () {
			// The request is interruptible even when the caller holds this in an uninterruptible acquire:
			// stopping a session must not wait out the client's retries.
			const resolution = yield* Effect.interruptible(api.resolveGithubToken({ sessionId })).pipe(
				Effect.mapError(
					(cause) =>
						new GithubCredentialsError({
							sessionId,
							reason: 'resolve',
							message:
								"Could not get this session's GitHub account from devflow, so the agent was not started (it would otherwise act as the host's own GitHub login).",
							cause: cause.cause,
						}),
				),
			)
			if ('useHostLogin' in resolution) return null

			const account: GithubAccountCredentials = {
				login: resolution.login,
				name: resolution.name,
				email: resolution.email,
				token: Redacted.make(resolution.token),
			}
			const problem = credentialProblem(account)
			if (problem !== null) {
				return yield* Effect.fail(
					new GithubCredentialsError({
						sessionId,
						reason: 'invalid',
						message: `Could not set up the GitHub account ${account.login} for this session: ${problem}.`,
					}),
				)
			}
			return account
		})

	const prepare = (input: PrepareGithubCredentialsInput) =>
		Effect.gen(function* () {
			const { sessionId } = input
			if (!isCredentialSessionId(sessionId)) {
				return yield* Effect.fail(
					new GithubCredentialsError({
						sessionId,
						reason: 'invalid',
						message: 'Could not set up the GitHub account for this session: its id is not a UUID.',
					}),
				)
			}
			const account = yield* resolveAccount(sessionId)
			const paths = credentialPaths(options.runDirectory, sessionId)
			return yield* lock.withPermits(1)(
				Effect.gen(function* () {
					const existing = entries.get(sessionId)
					if (account === null) {
						// Nothing to write, but remember the session: a switch to an account later must
						// restart its agent. An earlier run still pointed at a directory must stop acting
						// as the account.
						if (existing === undefined) {
							entries.set(sessionId, {
								taskId: input.taskId,
								scope: input.scope,
								mode: 'host',
								paths: null,
								holds: 1,
							})
						} else {
							existing.holds += 1
							existing.mode = 'host'
							if (existing.paths !== null)
								yield* lockCredentialFiles(sessionId, existing.paths, existing.scope)
						}
						return null
					}
					yield* writeCredentialFiles(paths, account, input.scope).pipe(
						Effect.catch((error) =>
							// A first write that failed leaves nothing behind; a rewrite keeps the files the
							// earlier run is using.
							(existing === undefined || existing.paths === null
								? removeSessionDirectory(sessionId, paths)
								: Effect.void
							).pipe(
								Effect.andThen(
									Effect.fail(
										new GithubCredentialsError({
											sessionId,
											reason: 'write',
											message: `Could not write the GitHub credentials for ${account.login}: ${error.message}`,
											cause: error,
										}),
									),
								),
							),
						),
					)
					if (existing === undefined) {
						entries.set(sessionId, {
							taskId: input.taskId,
							scope: input.scope,
							mode: 'account',
							paths,
							holds: 1,
						})
					} else {
						existing.holds += 1
						existing.mode = 'account'
						existing.scope = input.scope
						existing.paths = paths
					}
					yield* Effect.logInfo('Prepared the GitHub account for a session').pipe(
						Effect.annotateLogs({
							sessionId,
							taskId: input.taskId,
							login: account.login,
							scope: input.scope,
						}),
					)
					return githubEnvFor(paths)
				}),
			)
		}).pipe(Effect.withSpan('github_credentials.prepare', { attributes: { session_id: input.sessionId } }))

	/** Bring one prepared session in line with the task's new choice; undefined if it ended meanwhile. */
	const refreshSession = (sessionId: string) =>
		Effect.gen(function* () {
			// The new account, null for the host's own gh login, or undefined when it can't be read.
			const account: GithubAccountCredentials | null | undefined = yield* resolveAccount(sessionId).pipe(
				Effect.catch((error) =>
					Effect.logWarning("Could not read a session's new GitHub account; locking it").pipe(
						Effect.annotateLogs({ sessionId, reason: error.reason, error: error.message }),
						Effect.as(undefined),
					),
				),
			)
			return yield* lock.withPermits(1)(
				Effect.gen(function* () {
					const entry = entries.get(sessionId)
					if (entry === undefined) return undefined
					let outcome: GithubCredentialsRefresh['outcome']
					if (account !== null && account !== undefined && entry.mode === 'account' && entry.paths !== null) {
						const paths = entry.paths
						outcome = yield* writeCredentialFiles(paths, account, entry.scope).pipe(
							Effect.as('applied' as const),
							Effect.catch((error) =>
								Effect.logError('Could not rewrite a session GitHub credential directory').pipe(
									Effect.annotateLogs({ sessionId, login: account.login, error: error.message }),
									Effect.andThen(lockCredentialFiles(sessionId, paths, entry.scope)),
									Effect.as('restart' as const),
								),
							),
						)
					} else {
						// The host login (null), an account for an agent started without a directory, or
						// a choice that couldn't be read: nothing the running agent reads can carry it.
						if (entry.paths !== null) yield* lockCredentialFiles(sessionId, entry.paths, entry.scope)
						outcome = account === null && entry.mode === 'host' ? 'applied' : 'restart'
					}
					yield* Effect.logInfo("Refreshed a session's GitHub account").pipe(
						Effect.annotateLogs({
							sessionId,
							taskId: entry.taskId,
							mode: entry.mode,
							login: account?.login ?? (account === null ? 'host' : 'unknown'),
							outcome,
						}),
					)
					return { sessionId, outcome } satisfies GithubCredentialsRefresh
				}),
			)
		})

	const refresh = (taskId: string) =>
		Effect.gen(function* () {
			const sessionIds = [...entries.entries()]
				.filter(([, entry]) => entry.taskId === taskId)
				.map(([sessionId]) => sessionId)
			const results = yield* Effect.forEach(sessionIds, refreshSession)
			return results.filter((result) => result !== undefined)
		}).pipe(Effect.withSpan('github_credentials.refresh', { attributes: { task_id: taskId } }))

	const release = (sessionId: string) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const entry = entries.get(sessionId)
				if (entry === undefined) return
				entry.holds -= 1
				if (entry.holds > 0) return
				entries.delete(sessionId)
				if (entry.paths !== null) yield* removeSessionDirectory(sessionId, entry.paths)
			}),
		)

	// Daemon shutdown: no session outlives it, and no token stays on disk after it.
	yield* Effect.addFinalizer(() =>
		lock.withPermits(1)(
			Effect.forEach(
				[...entries.entries()],
				([sessionId, entry]) =>
					Effect.sync(() => entries.delete(sessionId)).pipe(
						Effect.andThen(
							entry.paths === null ? Effect.void : removeSessionDirectory(sessionId, entry.paths),
						),
					),
				{ discard: true },
			),
		),
	)

	return { prepare, refresh, release } satisfies GithubCredentialsService
})

/** Directories under `$DEVFLOW_HOME/run` (default `~/.devflow/run`), like the sandbox's own state. */
export const GithubCredentialsLive = Layer.effect(
	GithubCredentials,
	Effect.gen(function* () {
		const path = yield* Path.Path
		const home = yield* Config.String('HOME').pipe(Config.withDefault(homedir()))
		const devflowHome = yield* Config.String('DEVFLOW_HOME').pipe(Config.withDefault(path.join(home, '.devflow')))
		const xdgConfigHome = yield* Config.option(Config.String('XDG_CONFIG_HOME'))
		const gitConfigGlobal = yield* Config.option(Config.String('GIT_CONFIG_GLOBAL'))
		return yield* makeGithubCredentials({
			runDirectory: path.join(devflowHome, 'run'),
			hostGitConfigPaths: hostGlobalGitConfigPaths({
				HOME: home,
				XDG_CONFIG_HOME: Option.getOrUndefined(xdgConfigHome),
				GIT_CONFIG_GLOBAL: Option.getOrUndefined(gitConfigGlobal),
			}),
		})
	}),
)
