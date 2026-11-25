import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test, vi } from 'vitest'

import {
	createGithubRejectionHook,
	GITHUB_REJECTION_STOP_REASON,
} from '@/agents/claudecode/hooks/github-rejection-hook'
import type { GithubRejectionMatch } from '@/effects/services/github-credentials/rejection-signatures'

const signal = new AbortController().signal
const DENIED = 'remote: Permission to acme/api.git denied to stan-work.\nfatal: unable to access'

const base = { session_id: 'claude-session', transcript_path: '/tmp/t.jsonl', cwd: '/repo', tool_use_id: 'tool-1' }

const postToolUse = (command: string, stdout: string, stderr = '', toolName = 'Bash'): HookInput => ({
	...base,
	hook_event_name: 'PostToolUse',
	tool_name: toolName,
	tool_input: { command },
	tool_response: { stdout, stderr, interrupted: false },
})

const postToolUseFailure = (command: string, error: string, isInterrupt = false): HookInput => ({
	...base,
	hook_event_name: 'PostToolUseFailure',
	tool_name: 'Bash',
	tool_input: { command },
	error,
	is_interrupt: isInterrupt,
})

const hookWith = (stop: boolean | Error) => {
	const reported: GithubRejectionMatch[] = []
	const onRejection = vi.fn(async (rejection: GithubRejectionMatch) => {
		reported.push(rejection)
		if (stop instanceof Error) throw stop
		return stop
	})
	return { hook: createGithubRejectionHook({ sessionId: 'session-1', onRejection }), onRejection, reported }
}

describe('createGithubRejectionHook', () => {
	test('stops the agent when a failing push is refused and the daemon says to stop', async () => {
		const { hook, reported } = hookWith(true)

		await expect(
			hook(postToolUseFailure('git push', `Exit code 128\n${DENIED}`), 'tool-1', { signal }),
		).resolves.toEqual({ continue: false, stopReason: GITHUB_REJECTION_STOP_REASON })
		expect(reported).toMatchObject([{ signature: 'permission_denied', login: 'stan-work' }])
	})

	test('reads stdout and stderr of a command that exited cleanly', async () => {
		const { hook, reported } = hookWith(true)

		await expect(hook(postToolUse('git push || true', '', DENIED), 'tool-1', { signal })).resolves.toMatchObject({
			continue: false,
		})
		expect(reported).toHaveLength(1)
	})

	test('lets the agent go on when the daemon does not stop the run', async () => {
		const { hook } = hookWith(false)
		await expect(hook(postToolUseFailure('git push', DENIED), 'tool-1', { signal })).resolves.toEqual({
			continue: true,
		})
	})

	test('lets the agent go on when reporting fails', async () => {
		const { hook } = hookWith(new Error('daemon runtime gone'))
		await expect(hook(postToolUseFailure('git push', DENIED), 'tool-1', { signal })).resolves.toEqual({
			continue: true,
		})
	})

	test.each([
		{ name: 'output without a signature', input: postToolUse('git push', 'Everything up-to-date') },
		{ name: 'a command that is not git or gh', input: postToolUse('grep -rn "denied to" .', DENIED) },
		{ name: 'another tool', input: postToolUse('git push', DENIED, '', 'Read') },
		{ name: "the user's own interrupt", input: postToolUseFailure('git push', DENIED, true) },
	])('reports nothing for $name', async ({ input }) => {
		const { hook, onRejection } = hookWith(true)
		await expect(hook(input, 'tool-1', { signal })).resolves.toEqual({ continue: true })
		expect(onRejection).not.toHaveBeenCalled()
	})

	test('does nothing once the hook is aborted', async () => {
		const { hook, onRejection } = hookWith(true)
		const aborted = AbortSignal.abort()
		await expect(hook(postToolUseFailure('git push', DENIED), 'tool-1', { signal: aborted })).resolves.toEqual({
			continue: true,
		})
		expect(onRejection).not.toHaveBeenCalled()
	})
})
