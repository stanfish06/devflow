import { Effect } from 'effect'

import { GitHubIntegrationUnavailableError } from '../github.errors'

export const capturePullRequestFailure = (operation: string, organizationId: string) => (cause: unknown) =>
	Effect.logError('GitHub pull request operation failed', cause).pipe(
		Effect.annotateLogs({ operation, organization_id: organizationId }),
		Effect.andThen(Effect.fail(new GitHubIntegrationUnavailableError({ cause }))),
	)
