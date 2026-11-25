import { describe, expect, test } from 'vitest'

import {
	CLAUDE_CODE_START_FAILED_MESSAGE,
	getSessionErrorDisplayMessage,
	resolveSessionErrorReason,
} from '@/utils/session-error-messages'

describe('session error messages', () => {
	test('replaces a start_failed reason with start guidance', () => {
		expect(getSessionErrorDisplayMessage('start_failed', 'Unable to locate coding agent session ID.')).toBe(
			CLAUDE_CODE_START_FAILED_MESSAGE,
		)
	})

	test('treats the legacy session-id message as start_failed when no reason is stored', () => {
		expect(getSessionErrorDisplayMessage(null, 'Unable to locate coding agent session ID.')).toBe(
			CLAUDE_CODE_START_FAILED_MESSAGE,
		)
		expect(resolveSessionErrorReason(undefined, 'Unable to locate coding agent session ID.')).toBe('start_failed')
		expect(resolveSessionErrorReason('auth_required', 'Unable to locate coding agent session ID.')).toBe(
			'auth_required',
		)
	})

	test('names the refused GitHub account, whose login is the message', () => {
		expect(getSessionErrorDisplayMessage('github_token_rejected', 'stan-work')).toBe(
			"GitHub rejected stan-work's token. Replace it in Settings, or switch the task's GitHub account, then send a message to try again.",
		)
		expect(getSessionErrorDisplayMessage('github_no_repo_access', 'stan-work')).toBe(
			"stan-work can't push to this repository. Switch the task's GitHub account, then send a message to try again.",
		)
	})

	test('shows the raw message for other reasons', () => {
		expect(getSessionErrorDisplayMessage('auth_required', 'Not logged in')).toBe('Not logged in')
		expect(getSessionErrorDisplayMessage(null, 'could not locate the claude code binary')).toBe(
			'could not locate the claude code binary',
		)
		expect(getSessionErrorDisplayMessage(null, null)).toBeNull()
	})
})
