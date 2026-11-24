import { Context, Effect, Layer } from 'effect'

import { EnvironmentVariable } from '@/lib/effect/environment'

/** JWKS endpoint and refresh timing used by the JWKS cache. */
export class JWKSConfig extends Context.Service<
	JWKSConfig,
	{
		readonly jwksUrl: string
		readonly keyFetchTimeoutMs: number
		readonly refreshIntervalMs: number
	}
>()('JWKSConfig') {}

/** Reads the JWKS URL from `DEVFLOW_JWKS_URL` (the API's local JWKS endpoint). */
export const JWKSConfigLive = Layer.effect(
	JWKSConfig,
	Effect.gen(function* () {
		const jwksUrl = yield* EnvironmentVariable('DEVFLOW_JWKS_URL')

		return {
			jwksUrl,
			keyFetchTimeoutMs: 10_000,
			refreshIntervalMs: 300_000, // 5 minutes
		}
	}),
)
