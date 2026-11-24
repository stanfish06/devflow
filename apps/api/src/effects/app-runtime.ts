import { NodeCrypto } from '@effect/platform-node'
import { Config, Crypto, Effect, ManagedRuntime } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import type { HttpClient } from 'effect/http/HttpClient'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'

import { Directory } from '../auth/directory'
import { PersonalAccessTokenFileStoreLive, type PersonalAccessTokenStore } from '../auth/personal-access-tokens'
import { db, dbReadReplica } from '../db/db'
import { getLocalDirectory } from '../devflow/local-auth'
import type { ArtifactComments } from './services/artifact-comments/artifact-comments'
import { ArtifactCommentsLive } from './services/artifact-comments/artifact-comments-live'
import type { DiffComments } from './services/diff-comments/diff-comments'
import { DiffCommentsLive } from './services/diff-comments/diff-comments-live'
import {
	type DurableStreamsConfig,
	DurableStreamsConfigLive,
} from './services/durable-streams/durable-streams-config.service'
import { type DurableStreamSessionService, DurableStreamSessionServiceLive } from './services/durable-streams/streams'
import { type GitHubService, GitHubServiceLive } from './services/github/github.service'
import { type PersonSpendAnalytics, PersonSpendAnalyticsLive } from './services/metrics/person-spend-analytics.service'
import { type PostgresDb, PostgresDbLive } from './services/postgres/postgres-db.service'
import {
	type PostgresReadReplicaDb,
	PostgresReadReplicaDbLive,
} from './services/postgres/postgres-read-replica.service'
import { PrStatusStreamLive } from './services/pr-status-stream/pr-status-stream.layer'
import type { PrStatusStream } from './services/pr-status-stream/pr-status-stream.service'
import { type S3, S3Live } from './services/s3/s3.service'
import {
	type SessionTitleGeneration,
	SessionTitleGenerationLive,
} from './services/session-title-generation/session-title-generation.service'
import {
	type TaskDiffService,
	TaskDiffServiceLive,
} from './services/task-diff-durable-streams/task-diff-durable-streams.service'
import {
	type TaskIntentClassifier,
	TaskIntentClassifierLive,
} from './services/task-intent-classifier/task-intent-classifier.service'
import { TaskLaunchServiceLive } from './services/task-launch/task-launch.live'
import type { TaskLaunchService } from './services/task-launch/task-launch.service'
import { WorkspaceSetupServiceLive } from './services/workspace-setup/workspace-setup.live'
import { WorkspaceSetupPersistenceLive } from './services/workspace-setup/workspace-setup.persistence'
import type { WorkspaceSetupService } from './services/workspace-setup/workspace-setup.service'

/**
 * Type of all the services the app runtime will need
 */
export type AppRuntimeServices =
	| HttpClient
	| Directory
	| PersonalAccessTokenStore
	| PostgresDb
	| Crypto.Crypto
	| PostgresReadReplicaDb
	| PersonSpendAnalytics
	| S3
	| DurableStreamsConfig
	| DurableStreamSessionService
	| TaskDiffService
	| WorkspaceSetupService
	| GitHubService
	| DiffComments
	| ArtifactComments
	| TaskLaunchService
	| TaskIntentClassifier
	| PrStatusStream
	| SessionTitleGeneration

/**
 * The type for the actual runtime
 */
export type AppRuntimeInitializationError = Config.ConfigError

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppRuntimeServices, AppRuntimeInitializationError>

const EffectLoggerLive = Logger.layer([Logger.withConsoleLog(Logger.formatJson)])

/** The user directory seeded with the local user and organization. */
const DirectoryLive = Layer.effect(
	Directory,
	Effect.promise(() => getLocalDirectory()),
)

/**
 * The live app runtime layer tree.
 */
const BaseRuntimeLive = Layer.mergeAll(
	NodeCrypto.layer,
	EffectLoggerLive,
	PostgresDbLive(db),
	PostgresReadReplicaDbLive(dbReadReplica),
	S3Live,
	DurableStreamsConfigLive.pipe(Layer.orDie),
)
	// The one fetch transport, provided once. GitHub operations declare HttpClient in R and receive
	// this instance ambiently.
	.pipe(Layer.provideMerge(FetchHttpClient.layer))

const CoreServiceLive = Layer.mergeAll(
	DirectoryLive,
	PersonalAccessTokenFileStoreLive,
	DurableStreamSessionServiceLive,
	TaskDiffServiceLive.pipe(Layer.provide(FetchHttpClient.layer), Layer.orDie),
	WorkspaceSetupServiceLive.pipe(Layer.provide(WorkspaceSetupPersistenceLive)),
	GitHubServiceLive.pipe(Layer.orDie),
	// Reads DURABLE_STREAMS_ORIGIN through DurableStreamsConfig, provided by BaseRuntimeLive below.
	PrStatusStreamLive,
).pipe(Layer.provideMerge(BaseRuntimeLive))

const CommentServicesLive = Layer.mergeAll(DiffCommentsLive, ArtifactCommentsLive).pipe(Layer.provide(CoreServiceLive))

export const AppRuntimeLive = Layer.mergeAll(
	PersonSpendAnalyticsLive,
	TaskLaunchServiceLive,
	TaskIntentClassifierLive,
	SessionTitleGenerationLive,
	CommentServicesLive,
).pipe(Layer.provideMerge(CoreServiceLive))

/**
 * The managed runtime used by Effect oRPC procedures.
 */
export const appRuntime: AppRuntime = ManagedRuntime.make(AppRuntimeLive)
