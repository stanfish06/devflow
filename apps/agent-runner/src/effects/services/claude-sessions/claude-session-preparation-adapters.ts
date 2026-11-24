import { Data, Effect } from 'effect'

import { loadConfiguredRepoContext } from '@/lib/configured-repos/service'
import { commitAttributionEnv } from '@/lib/git/commit-attribution'
import { ensureRpiPluginOnDisk } from '@/plugins/ensure-plugin'

import { GithubCredentials, type PrepareGithubCredentialsInput } from '../github-credentials/github-credentials.service'

export class ClaudePreparationAdapterError extends Data.TaggedError('ClaudePreparationAdapterError')<{
	readonly capability:
		| 'rpi-plugin'
		| 'devflow-plugin'
		| 'artifact-paths'
		| 'configured-repositories'
		| 'commit-attribution'
	readonly cause: unknown
}> {}

const adaptPreparationPromise = <A>(
	capability: ClaudePreparationAdapterError['capability'],
	operation: () => Promise<A>,
) =>
	Effect.tryPromise({
		try: operation,
		catch: (cause) => new ClaudePreparationAdapterError({ capability, cause }),
	}).pipe(Effect.tapError(Effect.logError), Effect.withSpan(`claude.preparation.${capability.replaceAll('-', '_')}`))

// NOTE: wrap in an arrow that takes no arguments. `Effect.tryPromise` invokes its `try`
// callback with an `AbortSignal`; passing the bare `ensureRpiPluginOnDisk` reference would
// forward that signal as the `baseDir` argument, and `path.join(signal, ...)` throws
// `TypeError: paths[0] ... must be of type string`, failing every Effect-runtime launch.
export const materializeRpiPlugin = () => adaptPreparationPromise('rpi-plugin', () => ensureRpiPluginOnDisk())

export const prepareArtifactPaths = (input: {
	readonly workingDirectory: string
	readonly taskId: string
	readonly taskSlug: string
	readonly setupArtifactPaths: (
		cwd: string,
		taskId: string,
		taskSlug: string,
	) => Promise<{ storagePath: string; symlinkPath: string }>
}): Effect.Effect<{ readonly storagePath: string; readonly symlinkPath: string }, ClaudePreparationAdapterError> =>
	adaptPreparationPromise('artifact-paths', () =>
		input.setupArtifactPaths(input.workingDirectory, input.taskId, input.taskSlug),
	)

export const readConfiguredRepositoryContext = (input: {
	readonly workingDirectory: string
	readonly sessionId: string
	readonly workspaceDirectories?: string[]
	/** Provenance label for the workspace directories; defaults to the legacy setup ledger. */
	readonly workspaceSourcePath?: string
}) =>
	adaptPreparationPromise('configured-repositories', () => {
		const args: Parameters<typeof loadConfiguredRepoContext>[0] = {
			cwd: input.workingDirectory,
			sessionId: input.sessionId,
		}
		if (input.workspaceDirectories) args.workspaceDirectories = input.workspaceDirectories
		if (input.workspaceSourcePath !== undefined) args.workspaceSourcePath = input.workspaceSourcePath
		return loadConfiguredRepoContext(args)
	})

export const readCommitAttributionEnvironment = (input: {
	readonly sessionId: string
	readonly workingDirectory: string
}) =>
	adaptPreparationPromise('commit-attribution', () =>
		commitAttributionEnv(input.sessionId, { cwd: input.workingDirectory }),
	)

/**
 * The env fragment that makes the agent act as the session's GitHub account, or null to keep the
 * host's own gh login. The credential directory is held for as long as the enclosing scope (the run)
 * stays open, then released, which removes it once no run of the session holds it. A failure fails
 * the preparation: the session must not start as some other GitHub identity.
 */
export const readGithubCredentialEnvironment = (input: PrepareGithubCredentialsInput) =>
	Effect.gen(function* () {
		const credentials = yield* GithubCredentials
		return yield* Effect.acquireRelease(credentials.prepare(input), (githubEnv) =>
			githubEnv === null ? Effect.void : credentials.release(input.sessionId),
		)
	}).pipe(Effect.withSpan('claude.preparation.github_credentials'))
