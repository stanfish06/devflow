import type { EffectDecoratedProcedure, EffectErrorMap } from '@devflow/effect-orpc'
import { NodeCrypto } from '@effect/platform-node'
import type { AnySchema, Meta } from '@orpc/contract'
import type { Context } from '@orpc/server'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import type { HttpClient } from 'effect/http/HttpClient'

import { Directory, UserDirectory } from '../../src/auth/directory'
import { makeInMemoryPersonalAccessTokenStore, PersonalAccessTokenStore } from '../../src/auth/personal-access-tokens'
import type { AppRuntime, AppRuntimeInitializationError, AppRuntimeServices } from '../../src/effects/app-runtime'
import { ArtifactCommentsLive } from '../../src/effects/services/artifact-comments/artifact-comments-live'
import { DiffCommentsLive } from '../../src/effects/services/diff-comments/diff-comments-live'
import { DurableStreamsConfig } from '../../src/effects/services/durable-streams/durable-streams-config.service'
import { DurableStreamSessionServiceLive } from '../../src/effects/services/durable-streams/streams'
import { GitHubService } from '../../src/effects/services/github/github.service'
import { PersonSpendAnalyticsLive } from '../../src/effects/services/metrics/person-spend-analytics.service'
import { PostgresDbLive } from '../../src/effects/services/postgres/postgres-db.service'
import { PostgresReadReplicaDbLive } from '../../src/effects/services/postgres/postgres-read-replica.service'
import { PrStatusStream } from '../../src/effects/services/pr-status-stream/pr-status-stream.service'
import { S3 } from '../../src/effects/services/s3/s3.service'
import { SessionTitleGeneration } from '../../src/effects/services/session-title-generation/session-title-generation.service'
import { TaskDiffServiceLive } from '../../src/effects/services/task-diff-durable-streams/task-diff-durable-streams.service'
import { TaskIntentClassifier } from '../../src/effects/services/task-intent-classifier/task-intent-classifier.service'
import { TaskLaunchServiceLive } from '../../src/effects/services/task-launch/task-launch.live'
import { WorkspaceSetupServiceLive } from '../../src/effects/services/workspace-setup/workspace-setup.live'
import { WorkspaceSetupPersistenceLive } from '../../src/effects/services/workspace-setup/workspace-setup.persistence'

export type TestRuntimeOptions = {
	durableStreamsOrigin?: string
	/**
	 * Backs `PostgresReadReplicaDb`. Defaults to the same database as the
	 * primary, which is what production does locally too
	 * (`READ_REPLICA_DATABASE_URL` = `DATABASE_URL`). Pass a second database
	 * only when the test is ABOUT replica lag.
	 */
	readReplicaDb?: PgDatabase<PostgresJsQueryResultHKT>
	/** Defaults to an empty directory. */
	directory?: Layer.Layer<Directory>
	/** Defaults to an empty in-memory store. */
	personalAccessTokens?: Layer.Layer<PersonalAccessTokenStore>
	github?: Layer.Layer<GitHubService>
	prStatusStream?: Layer.Layer<PrStatusStream>
	s3?: Layer.Layer<S3>
	taskIntentClassifier?: Layer.Layer<TaskIntentClassifier>
	sessionTitleGeneration?: Layer.Layer<SessionTitleGeneration>
	/**
	 * The transport the runtime hands to services that declare HttpClient. Defaults to the real
	 * fetch transport, as production does. Override it when a test must not reach the network.
	 */
	httpClient?: Layer.Layer<HttpClient>
}

function testDurableStreamsConfigLayer(origin: string) {
	return Layer.succeed(DurableStreamsConfig, {
		origin,
		contentType: 'application/json',
		ttlSeconds: 600,
		streamUrl: (sessionId: string) => `${origin}/v1/stream/sessions/${sessionId}`,
	})
}

/** Runtime layer backed by the given directory instance. */
export const directoryLayer = (directory: UserDirectory) => Layer.succeed(Directory, directory)

const s3TestLayer = Layer.succeed(S3, {
	getPresignedDownloadUrl: (key: string) =>
		Effect.succeed(`https://example.test/download/${encodeURIComponent(key)}`),
	getPresignedUploadUrl: (key: string) => Effect.succeed(`https://example.test/upload/${encodeURIComponent(key)}`),
	presignDownload: ({ key }) => Effect.succeed(`https://example.test/download/${encodeURIComponent(key)}`),
	presignUpload: ({ key }) => Effect.succeed(`https://example.test/upload/${encodeURIComponent(key)}`),
	uploadArtifactBytes: () => Effect.void,
})

const fakeGitHubLayer = Layer.succeed(GitHubService, {
	createInstallUrl: () => Effect.die('createInstallUrl not implemented in test runtime'),
	completeInstallation: () => Effect.die('completeInstallation not implemented in test runtime'),
	listConnections: () => Effect.die('listConnections not implemented in test runtime'),
	getConnection: () => Effect.die('getConnection not implemented in test runtime'),
	mutatePullRequest: () => Effect.die('mutatePullRequest not implemented in test runtime'),
	listRepositories: () => Effect.die('listRepositories not implemented in test runtime'),
	getIssuePreview: () => Effect.die('getIssuePreview not implemented in test runtime'),
	prepareIssueImport: () => Effect.die('prepareIssueImport not implemented in test runtime'),
	syncArtifactBacklink: () => Effect.die('syncArtifactBacklink not implemented in test runtime'),
	refreshConnection: () => Effect.die('refreshConnection not implemented in test runtime'),
	disconnect: () => Effect.die('disconnect not implemented in test runtime'),
	fetchPullRequest: () => Effect.die('fetchPullRequest not implemented in test runtime'),
	verifyWebhook: () => Effect.die('verifyWebhook not implemented in test runtime'),
	handleWebhook: () => Effect.void,
})

/**
 * The PR-status stream writer for procedure tests that never touch it.
 *
 * Every method dies, like the other fakes here: a procedure that writes to the stream unexpectedly
 * should fail loudly rather than silently succeed against a no-op. The one suite that does
 * exercise the stream — `procedures/github-ensure-stream.test.ts` — passes its own
 * `prStatusStream` layer and asserts on what it recorded.
 */
const fakePrStatusStreamLayer = Layer.succeed(PrStatusStream, {
	hydrate: () => Effect.die('PrStatusStream.hydrate not implemented in test runtime'),
	publishChecks: () => Effect.die('PrStatusStream.publishChecks not implemented in test runtime'),
	publishPullRequest: () => Effect.die('PrStatusStream.publishPullRequest not implemented in test runtime'),
})

const fakeTaskIntentClassifierLayer = Layer.succeed(TaskIntentClassifier, {
	classify: (text) =>
		Effect.succeed(
			text.startsWith('How does')
				? 'research'
				: text.startsWith("Let's make a plan")
					? 'design'
					: text.startsWith('Unclear')
						? 'unknown'
						: 'implementation',
		),
})

const fakeSessionTitleGenerationLayer = Layer.succeed(SessionTitleGeneration, {
	scheduleGeneration: () => Effect.void,
})

export function createRuntimeWithTestPostgresLayer(
	db: PgDatabase<PostgresJsQueryResultHKT>,
	options?: TestRuntimeOptions,
): AppRuntime {
	const durableStreamsOrigin =
		options?.durableStreamsOrigin ?? process.env.DURABLE_STREAMS_ORIGIN ?? 'http://durable-streams.test'
	const durableStreamsConfig = testDurableStreamsConfigLayer(durableStreamsOrigin)
	const taskDiffConfig = ConfigProvider.layer(
		ConfigProvider.fromUnknown({ DURABLE_STREAMS_ORIGIN: durableStreamsOrigin }),
	)

	const directory = options?.directory ?? directoryLayer(new UserDirectory())
	const workspaceSetupLayer = WorkspaceSetupServiceLive.pipe(
		Layer.provide(WorkspaceSetupPersistenceLive),
		Layer.provide(PostgresDbLive(db)),
	)
	const commentLayers = Layer.mergeAll(DiffCommentsLive, ArtifactCommentsLive).pipe(
		Layer.provide(Layer.mergeAll(PostgresDbLive(db), directory)),
	)

	return ManagedRuntime.make(
		Layer.mergeAll(
			PostgresDbLive(db),
			NodeCrypto.layer,
			PostgresReadReplicaDbLive(options?.readReplicaDb ?? db),
			PersonSpendAnalyticsLive,
			options?.s3 ?? s3TestLayer,
			directory,
			options?.personalAccessTokens ??
				Layer.succeed(PersonalAccessTokenStore, makeInMemoryPersonalAccessTokenStore()),
			durableStreamsConfig,
			DurableStreamSessionServiceLive,
			TaskDiffServiceLive.pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, taskDiffConfig)), Layer.orDie),
			commentLayers,
			workspaceSetupLayer,
			TaskLaunchServiceLive,
			options?.taskIntentClassifier ?? fakeTaskIntentClassifierLayer,
			options?.sessionTitleGeneration ?? fakeSessionTitleGenerationLayer,
			options?.github ?? fakeGitHubLayer,
			options?.prStatusStream ?? fakePrStatusStreamLayer,
		)
			// Mirrors production: one transport, provided once, ambient to every service that needs it.
			.pipe(Layer.provideMerge(options?.httpClient ?? FetchHttpClient.layer)),
	)
}

/**
 * App-runtime-typed runtime for tests that only need the runtime seam to exist.
 */
export function createDefaultTestEffectRuntime(options?: TestRuntimeOptions): AppRuntime {
	return createRuntimeWithTestPostgresLayer({} as PgDatabase<PostgresJsQueryResultHKT>, options)
}

export function bindProcedureToRuntime<
	TInitialContext extends Context,
	TCurrentContext extends Context,
	TInputSchema extends AnySchema,
	TOutputSchema extends AnySchema,
	TErrorMap extends EffectErrorMap,
	TMeta extends Meta,
>(
	procedure: EffectDecoratedProcedure<
		TInitialContext,
		TCurrentContext,
		TInputSchema,
		TOutputSchema,
		TErrorMap,
		TMeta,
		AppRuntimeServices,
		AppRuntimeInitializationError
	>,
	runtime: AppRuntime,
) {
	return procedure.withRuntime(runtime)
}
