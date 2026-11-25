import { Effect } from 'effect'

import type { InterruptStateService } from '@/agents/shared/interrupt-state.service'

import { GithubCredentials } from './github-credentials.service'
import type { GithubRejectionMatch } from './rejection-signatures'

/**
 * A command in the session hit a GitHub auth failure. Report it, and when the API says to stop,
 * record the failure on the run's interrupt state: once the agent has stopped, the session fails
 * with `github_token_rejected` or `github_no_repo_access` and the refused login as its message.
 *
 * Returns true when the run must stop; the caller then interrupts its agent. Never fails.
 */
export const stopRunOnGithubRejection = Effect.fn('github_credentials.stop_run_on_rejection')(function* (input: {
	readonly sessionId: string
	readonly rejection: GithubRejectionMatch
	readonly interruptState: InterruptStateService
}) {
	const credentials = yield* GithubCredentials
	const stop = yield* credentials.reportRejection({ sessionId: input.sessionId, rejection: input.rejection })
	if (stop === null) return false
	// Only the first rejection is recorded; a second one in the same run changes nothing.
	yield* input.interruptState.markFailed({ reason: stop.reason, message: stop.login })
	return true
})
