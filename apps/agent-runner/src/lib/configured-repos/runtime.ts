import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import { Effect, Layer, ManagedRuntime } from 'effect'

import logger from '@/logger'

import { ConfiguredRepoTelemetry, GitRootResolverLive } from './load-configured-repo-context'
import { type ConfiguredRepoContext, ConfiguredRepoContextLive } from './service'

export const LoggerConfiguredRepoTelemetryLive = Layer.succeed(ConfiguredRepoTelemetry, {
	info: (observation) =>
		Effect.sync(() => {
			logger.info({ discovery: 'configured-repos', ...observation }, 'Configured repo discovery')
		}),
	capture: (_warning, context) =>
		Effect.sync(() => {
			logger.error(
				{ discovery: 'configured-repos', outcome: 'error', ...context },
				'Configured repo discovery failed',
			)
		}),
})

/**
 * The configured-repository service with its daemon adapters. File access comes from the ambient
 * platform `FileSystem`, which the daemon runtime provides once through `BunServices`.
 */
export const ConfiguredRepoContextRuntimeLive = ConfiguredRepoContextLive.pipe(
	Layer.provide(Layer.mergeAll(GitRootResolverLive, LoggerConfiguredRepoTelemetryLive)),
)

export type ConfiguredRepoContextRuntime = ManagedRuntime.ManagedRuntime<ConfiguredRepoContext, unknown>

/** Standalone runtime for the promise bridge in `service.ts`; callers inside the daemon runtime yield the service. */
export const configuredRepoContextRuntime = ManagedRuntime.make(
	ConfiguredRepoContextRuntimeLive.pipe(Layer.provide(BunFileSystem.layer)),
)
