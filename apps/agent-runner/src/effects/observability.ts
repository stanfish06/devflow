import { Cause } from 'effect'

import logger from '@/logger'

import type { ExecuteClaudeSessionInput } from './services/claude-sessions/claude-sessions.service'

/** Log an unhandled session Cause at the sole Promise compatibility boundary. */
export function captureClaudeTerminalCause(cause: Cause.Cause<unknown>, input: ExecuteClaudeSessionInput): void {
	logger.error(
		{ error: Cause.squash(cause), cause: Cause.pretty(cause), sessionId: input.context.session.id },
		'Claude session execution failed',
	)
}
