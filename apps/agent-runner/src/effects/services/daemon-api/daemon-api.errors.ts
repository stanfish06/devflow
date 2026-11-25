import type { WorkspaceRepositoryActorSnapshot } from '@devflow/schemas/effect/project-workspace'
import { Data } from 'effect'

export class DaemonSettingsGetError extends Data.TaggedError('DaemonSettingsGetError')<{
	readonly cause: unknown
}> {}

export class DaemonContextShardsListError extends Data.TaggedError('DaemonContextShardsListError')<{
	readonly cause: unknown
}> {}

export class DaemonSessionUpdateError extends Data.TaggedError('DaemonSessionUpdateError')<{
	readonly cause: unknown
}> {}

export class DaemonConversationEventCreateError extends Data.TaggedError('DaemonConversationEventCreateError')<{
	readonly cause: unknown
}> {}

export class DaemonUsageRecordError extends Data.TaggedError('DaemonUsageRecordError')<{
	readonly cause: unknown
}> {}

export class DaemonConversationStreamHydrationError extends Data.TaggedError('DaemonConversationStreamHydrationError')<{
	readonly cause: unknown
}> {}

export class DaemonAgentCommandsReportError extends Data.TaggedError('DaemonAgentCommandsReportError')<{
	readonly cause: unknown
}> {}

export class DaemonTaskCapabilityError extends Data.TaggedError('DaemonTaskCapabilityError')<{
	readonly cause: unknown
}> {}

export class DaemonApprovalCreateError extends Data.TaggedError('DaemonApprovalCreateError')<{
	readonly cause: unknown
}> {}

export class DaemonWorkspaceRepositoryApiError extends Data.TaggedError('DaemonWorkspaceRepositoryApiError')<{
	readonly cause: unknown
}> {}

/** This status target cannot be read by the calling daemon; retire its setup job. */
export class DaemonWorkspaceRepositoryStatusUnavailable extends Data.TaggedError(
	'DaemonWorkspaceRepositoryStatusUnavailable',
)<{
	readonly workspaceId: string
	readonly repositoryIdentity: string
	readonly code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST'
}> {}

export class DaemonWorkspaceRepositoryStatusChanged extends Data.TaggedError('DaemonWorkspaceRepositoryStatusChanged')<{
	readonly snapshot: WorkspaceRepositoryActorSnapshot
}> {}

export class DaemonWorkspaceSessionSetupError extends Data.TaggedError('DaemonWorkspaceSessionSetupError')<{
	readonly cause: unknown
}> {}

/** The API no longer serves this session for the calling daemon: deleted, moved, or never owned. */
export class DaemonWorkspaceSessionSetupNotFound extends Data.TaggedError('DaemonWorkspaceSessionSetupNotFound')<{
	readonly sessionId: string
	readonly workspaceId: string
}> {}

/** The task has no project workspace, or this daemon's user may not read it. */
export class DaemonTaskWorkspaceContextNotFound extends Data.TaggedError('DaemonTaskWorkspaceContextNotFound')<{
	readonly taskId: string
}> {}

export class DaemonTaskWorkspaceContextError extends Data.TaggedError('DaemonTaskWorkspaceContextError')<{
	readonly taskId: string
	readonly cause: unknown
}> {}

/**
 * The API didn't say which GitHub account a session acts as. Carries the transport error only: the
 * token is in the response body, which a failed request never has.
 */
export class DaemonGithubTokenResolveError extends Data.TaggedError('DaemonGithubTokenResolveError')<{
	readonly sessionId: string
	readonly cause: unknown
}> {}

/** The API couldn't judge a GitHub rejection a session reported (GitHub unreachable, or a transport error). */
export class DaemonGithubRejectionReportError extends Data.TaggedError('DaemonGithubRejectionReportError')<{
	readonly sessionId: string
	readonly cause: unknown
}> {}

export type DaemonApiError =
	| DaemonSettingsGetError
	| DaemonContextShardsListError
	| DaemonSessionUpdateError
	| DaemonConversationEventCreateError
	| DaemonUsageRecordError
	| DaemonConversationStreamHydrationError
	| DaemonApprovalCreateError
	| DaemonWorkspaceRepositoryApiError
	| DaemonWorkspaceRepositoryStatusUnavailable
	| DaemonWorkspaceRepositoryStatusChanged
	| DaemonWorkspaceSessionSetupError
	| DaemonWorkspaceSessionSetupNotFound
	| DaemonAgentCommandsReportError
	| DaemonTaskCapabilityError
	| DaemonTaskWorkspaceContextNotFound
	| DaemonTaskWorkspaceContextError
	| DaemonGithubTokenResolveError
	| DaemonGithubRejectionReportError
