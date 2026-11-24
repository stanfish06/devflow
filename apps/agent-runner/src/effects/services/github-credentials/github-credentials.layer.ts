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
	renderTokenFile,
	type CredentialPaths,
	type GithubAccountCredentials,
} from './credential-files'
import {
	GithubCredentials,
	GithubCredentialsError,
	type GithubCredentialScope,
	type GithubCredentialsService,
	type PrepareGithubCredentialsInput,
} from './github-credentials.service'

const PRIVATE_DIRECTORY = 0o700
const PRIVATE_FILE = 0o600

/** A session whose credential directory is on disk, and how many runs still hold it. */
interface CredentialEntry {
	readonly taskId: string | null
	readonly paths: CredentialPaths
	holds: number
}

export interface GithubCredentialsOptions {
	/** Parent of every session's directory: `~/.devflow/run`. */
	readonly runDirectory: string
	/** The host user's global git config files, included under a non-sandboxed agent's gitconfig. */
	readonly hostGitConfigPaths: readonly string[]
}

/**
 * Build the service. The map of live directories is what a later task-level account switch will
 * walk to rewrite them; the semaphore keeps a session's write and removal from interleaving.
 */
export const makeGithubCredentials = Effect.fn('github_credentials.make')(function* (
	options: GithubCredentialsOptions,
) {
	const api = yield* DaemonApi
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = new Map<string, CredentialEntry>()
	const lock = yield* Semaphore.make(1)

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
				renderGitconfig({
					account,
					tokenFile: paths.tokenFile,
					includePaths: scope === 'host' ? options.hostGitConfigPaths : [],
				}),
			)
		})

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

			const paths = credentialPaths(options.runDirectory, sessionId)
			return yield* lock.withPermits(1)(
				Effect.gen(function* () {
					const existing = entries.get(sessionId)
					yield* writeCredentialFiles(paths, account, input.scope).pipe(
						Effect.catch((error) =>
							// A first write that failed leaves nothing behind; a rewrite keeps the files the
							// earlier run is using.
							(existing === undefined ? removeSessionDirectory(sessionId, paths) : Effect.void).pipe(
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
					if (existing === undefined) entries.set(sessionId, { taskId: input.taskId, paths, holds: 1 })
					else existing.holds += 1
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

	const release = (sessionId: string) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const entry = entries.get(sessionId)
				if (entry === undefined) return
				entry.holds -= 1
				if (entry.holds > 0) return
				entries.delete(sessionId)
				yield* removeSessionDirectory(sessionId, entry.paths)
			}),
		)

	// Daemon shutdown: no session outlives it, and no token stays on disk after it.
	yield* Effect.addFinalizer(() =>
		lock.withPermits(1)(
			Effect.forEach(
				[...entries.entries()],
				([sessionId, entry]) =>
					Effect.sync(() => entries.delete(sessionId)).pipe(
						Effect.andThen(removeSessionDirectory(sessionId, entry.paths)),
					),
				{ discard: true },
			),
		),
	)

	return { prepare, release } satisfies GithubCredentialsService
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
