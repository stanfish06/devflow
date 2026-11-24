import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'

import { JWKSConfig, JWKSConfigLive } from '../../src/auth/effect/jwks-cache-config.service'
import { EnvironmentVariableNotFoundError } from '../../src/lib/effect/environment'

const withEnv = (env: Record<string, string>) =>
	JWKSConfigLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))

describe('JWKSConfig', () => {
	it.effect('reads jwksUrl from DEVFLOW_JWKS_URL', ({ expect }) =>
		Effect.gen(function* () {
			const config = yield* JWKSConfig

			expect(config.jwksUrl).toBe('http://127.0.0.1:3000/devflow/auth/jwks')
			expect(config.keyFetchTimeoutMs).toBe(10_000)
			expect(config.refreshIntervalMs).toBe(300_000) // 5 minutes
		}).pipe(Effect.provide(withEnv({ DEVFLOW_JWKS_URL: 'http://127.0.0.1:3000/devflow/auth/jwks' }))),
	)

	it.effect('fails when DEVFLOW_JWKS_URL is missing', ({ expect }) =>
		Effect.gen(function* () {
			const readConfig = Effect.gen(function* () {
				return yield* JWKSConfig
			})
			const error = yield* Effect.flip(readConfig.pipe(Effect.provide(withEnv({}))))

			expect(error).toEqual(new EnvironmentVariableNotFoundError({ variableName: 'DEVFLOW_JWKS_URL' }))
		}),
	)
})

describe('JWKSConfig - Direct Test Layer', () => {
	const JWKSConfigTest = Layer.succeed(JWKSConfig, {
		jwksUrl: 'http://localhost:9999/mock-jwks',
		keyFetchTimeoutMs: 100, // Fast for tests
		refreshIntervalMs: 1_000,
	})

	it.effect('can provide JWKSConfig directly', ({ expect }) =>
		Effect.gen(function* () {
			const config = yield* JWKSConfig

			expect(config.jwksUrl).toBe('http://localhost:9999/mock-jwks')
			expect(config.keyFetchTimeoutMs).toBe(100)
			expect(config.refreshIntervalMs).toBe(1_000)
		}).pipe(Effect.provide(JWKSConfigTest)),
	)
})
