import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

import {
	type GithubRejectionMatch,
	matchGithubRejection,
} from '@/effects/services/github-credentials/rejection-signatures'
import logger from '@/logger'

export interface GithubRejectionHookDeps {
	readonly sessionId: string
	/**
	 * A Bash command failed with a GitHub auth signature: report it, and resolve true when the run
	 * must stop (the daemon has then already begun stopping it).
	 */
	readonly onRejection: (rejection: GithubRejectionMatch) => Promise<boolean>
}

/** What the agent is told when the daemon stops it. */
export const GITHUB_REJECTION_STOP_REASON =
	"GitHub refused this task's GitHub account. devflow stopped the run so nothing is pushed as another account."

/**
 * Watches Bash results for GitHub refusing the session's account (`git push`, `gh pr create`, …).
 * Registered for both `PostToolUse` and `PostToolUseFailure`: a failing command (non-zero exit)
 * only reaches the second. On a confirmed rejection the agent is told to stop at once, so it can't
 * try another way round before the daemon's interrupt lands.
 */
export function createGithubRejectionHook(deps: GithubRejectionHookDeps): HookCallback {
	return async (
		input: HookInput,
		_toolUseID: string | undefined,
		options: { signal: AbortSignal },
	): Promise<HookJSONOutput> => {
		if (options.signal.aborted) return { continue: true }
		const result = bashResultOf(input)
		if (result === null) return { continue: true }
		const rejection = matchGithubRejection(result)
		if (rejection === null) return { continue: true }
		try {
			if (!(await deps.onRejection(rejection))) return { continue: true }
		} catch (error) {
			logger.error(
				{ err: error, sessionId: deps.sessionId },
				'Could not handle a GitHub refusal in a Bash result',
			)
			return { continue: true }
		}
		return { continue: false, stopReason: GITHUB_REJECTION_STOP_REASON }
	}
}

/** The command and everything it printed, for a finished Bash call; null for anything else. */
function bashResultOf(input: HookInput): { command: string; output: string } | null {
	if (input.hook_event_name === 'PostToolUse') {
		if (input.tool_name !== 'Bash') return null
		return { command: commandOf(input.tool_input), output: outputOf(input.tool_response) }
	}
	if (input.hook_event_name === 'PostToolUseFailure') {
		// The user's own interrupt is not GitHub's answer.
		if (input.tool_name !== 'Bash' || input.is_interrupt) return null
		return { command: commandOf(input.tool_input), output: input.error }
	}
	return null
}

function commandOf(toolInput: unknown): string {
	if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return ''
	return typeof toolInput.command === 'string' ? toolInput.command : ''
}

function outputOf(toolResponse: unknown): string {
	if (typeof toolResponse === 'string') return toolResponse
	if (typeof toolResponse !== 'object' || toolResponse === null) return ''
	const parts: string[] = []
	if ('stdout' in toolResponse && typeof toolResponse.stdout === 'string') parts.push(toolResponse.stdout)
	if ('stderr' in toolResponse && typeof toolResponse.stderr === 'string') parts.push(toolResponse.stderr)
	return parts.join('\n')
}
