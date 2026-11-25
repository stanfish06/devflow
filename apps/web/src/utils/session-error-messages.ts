import type { SessionErrorReason } from '@devflow/schemas/effect/session/session-error-reason'

export const CLAUDE_CODE_START_FAILED_MESSAGE =
	'Claude Code failed to start. Try updating Claude Code and create a new session'

// Sessions that failed before `sessions.error_reason` existed carry only this message.
const LEGACY_START_FAILED_MESSAGE = 'Unable to locate coding agent session ID'

export function resolveSessionErrorReason(
	errorReason: SessionErrorReason | null | undefined,
	errorMessage: string | null | undefined,
): SessionErrorReason | null {
	if (errorReason) return errorReason
	return errorMessage?.includes(LEGACY_START_FAILED_MESSAGE) ? 'start_failed' : null
}

export function getSessionErrorDisplayMessage(
	errorReason: SessionErrorReason | null | undefined,
	errorMessage: string | null | undefined,
): string | null | undefined {
	const reason = resolveSessionErrorReason(errorReason, errorMessage)
	if (reason === 'start_failed') return CLAUDE_CODE_START_FAILED_MESSAGE
	// For the GitHub reasons the message is only the refused account's login.
	const account = errorMessage?.trim() || 'the account'
	if (reason === 'github_token_rejected')
		return `GitHub rejected ${account}'s token. Replace it in Settings, or switch the task's GitHub account, then send a message to try again.`
	if (reason === 'github_no_repo_access')
		return `${account} can't push to this repository. Switch the task's GitHub account, then send a message to try again.`
	return errorMessage
}
