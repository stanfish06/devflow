import { resolveLocalSession } from '../auth'
import type { EnvironmentName } from '../lib/macros'
import { resolveEnvironmentConfig } from '../lib/macros'
import { type ApiORPCClient, createApiORPCClient } from '../orpc/client'

export function createLazyClient(getEnv: () => EnvironmentName): () => Promise<ApiORPCClient> {
	let cachedClient: ApiORPCClient | null = null

	return async () => {
		if (cachedClient) return cachedClient

		try {
			const envName = getEnv()
			const envConfig = resolveEnvironmentConfig(envName)
			const session = await resolveLocalSession(envConfig)
			cachedClient = createApiORPCClient(envConfig.apiOrigin, session.accessToken)
			return cachedClient
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`Authentication failed: ${message}`)
			console.error('Check that the API is running, or use --local/--dev to target another environment.')
			process.exit(1)
		}
	}
}
