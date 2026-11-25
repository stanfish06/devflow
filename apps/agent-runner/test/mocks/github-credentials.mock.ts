import { Effect, Layer } from 'effect'

import {
	GithubCredentials,
	type GithubCredentialsService,
} from '@/effects/services/github-credentials/github-credentials.service'

/**
 * GithubCredentials for tests that don't exercise GitHub accounts: every session keeps the host's
 * own gh login, so nothing is written and the agent env is untouched.
 */
export function makeHostLoginGithubCredentials(overrides: Partial<GithubCredentialsService> = {}) {
	return Layer.succeed(GithubCredentials, {
		prepare: () => Effect.succeed(null),
		refresh: () => Effect.succeed([]),
		release: () => Effect.void,
		reportRejection: () => Effect.succeed(null),
		...overrides,
	})
}
