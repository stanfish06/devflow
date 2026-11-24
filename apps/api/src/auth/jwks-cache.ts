import { importJWK } from 'jose'

import { localJwks } from '../devflow/local-auth'
import { logger } from '../logger'

type ImportedJwk = Awaited<ReturnType<typeof importJWK>>

/** Verification keys by `kid`, imported from the local signing key. */
export class JWKSCache {
	private keys = new Map<string, ImportedJwk>()

	async start(): Promise<void> {
		await this.refreshKeys()
	}

	async forceRefresh(): Promise<void> {
		await this.refreshKeys()
	}

	private async refreshKeys(): Promise<void> {
		try {
			const newKeys = new Map<string, ImportedJwk>()
			for (const jwk of localJwks().keys) {
				if (jwk.kid) newKeys.set(jwk.kid, await importJWK(jwk))
			}
			this.keys = newKeys
		} catch (error) {
			// Keep existing keys if the key file cannot be read
			logger.error(error, 'JWKS refresh failed')
		}
	}

	getKey(kid: string): ImportedJwk | undefined {
		return this.keys.get(kid)
	}
}

export const jwksCache = new JWKSCache()
