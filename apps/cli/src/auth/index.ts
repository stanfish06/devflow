import type { EnvironmentConfig } from '../lib/macros'

export interface LocalSession {
	accessToken: string
	expiresAt: number // Unix timestamp in milliseconds
	userId: string
	organizationId: string
}

/** Ask the API for the local user's access token (apps/api/src/devflow/local-auth.ts). */
export async function resolveLocalSession(envConfig: EnvironmentConfig): Promise<LocalSession> {
	const response = await fetch(`${envConfig.apiOrigin}/devflow/auth/session`, { method: 'POST' })
	if (!response.ok) {
		throw new Error(`Could not get a local session from ${envConfig.apiOrigin}: HTTP ${response.status}`)
	}
	const session = (await response.json()) as {
		accessToken: string
		expiresAt: number
		user: { id: string }
		organizationId: string
	}
	return {
		accessToken: session.accessToken,
		expiresAt: session.expiresAt,
		userId: session.user.id,
		organizationId: session.organizationId,
	}
}
