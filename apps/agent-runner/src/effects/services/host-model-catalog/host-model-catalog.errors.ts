import { Data } from 'effect'

export type ClaudeModelProbeOperation = 'spawn' | 'supported_models' | 'timeout'

/** The installed Claude Code binary could not report its models. */
export class ClaudeModelProbeError extends Data.TaggedError('ClaudeModelProbeError')<{
	readonly operation: ClaudeModelProbeOperation
	readonly cause?: unknown
}> {
	/** A missing or failing binary is a host condition, not a defect worth an alert. */
	get unexpected(): boolean {
		return this.operation === 'supported_models'
	}
}

export type CodexModelProbeReason = 'binary_missing' | 'not_logged_in' | 'transport' | 'malformed_response' | 'timeout'

/** The Codex CLI's app-server could not report its models. */
export class CodexModelProbeError extends Data.TaggedError('CodexModelProbeError')<{
	readonly reason: CodexModelProbeReason
	readonly cause?: unknown
}> {
	/** A missing binary or login is host configuration, not a failure to alert on. */
	get unexpected(): boolean {
		return this.reason !== 'binary_missing' && this.reason !== 'not_logged_in'
	}
}
