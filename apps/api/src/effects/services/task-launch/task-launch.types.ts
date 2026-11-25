import type { PermissionsMode } from '@devflow/db/tables/sessions'
import type { TicketProvider } from '@devflow/db/tables/tasks'
import type { Task } from '@devflow/db/tables/tasks'
import type { CreatedWithExperimentFlags } from '@devflow/db/zodschemas/created-with-experiment-flags'
import type { CodingAgent } from '@devflow/schemas/coding-agent'
import type { TaskStatus } from '@devflow/schemas/effect/taskconfiguration'
import type { WorkspaceSpec } from '@devflow/schemas/effect/workspace'
import type { TaskIntent } from '@devflow/schemas/task-intent'

import type { GitHubPreparedImageArtifact } from '../github/github.schema'

/** An imported ticket written as its own artifact, plus its downloaded images. */
export interface PreparedTicketArtifactBundle {
	readonly label: string
	readonly fileName: string
	readonly content: string
	readonly contentHash: string
	readonly images: ReadonlyArray<GitHubPreparedImageArtifact>
}

export type TaskLaunchAttachment = {
	readonly fileName: string
	readonly contentType: string
	readonly fileSizeBytes: number
	readonly contentHash: string
}

export type TaskLaunchFirstSession = {
	readonly id: string
	readonly eventId: string
	readonly title: string | null
	readonly text: string
	readonly workingDirectory: string
	readonly hostId: string
	readonly codingAgent: CodingAgent
	readonly provider: string
	readonly model: string
	readonly effort?: string | null
	readonly fastMode?: boolean | null
	readonly permissionsMode: PermissionsMode
	/** Set by the launcher when it knows; otherwise freeform launches are classified. */
	readonly intent?: Exclude<TaskIntent, 'unknown'>
}

export type LaunchTaskDraftInput = {
	readonly draftId: string
	readonly organizationId: string
	readonly userId: string
	readonly name: string
	readonly slug: string
	readonly defaultWorkingDirectory: string
	readonly taskContent: string
	readonly workspaceSpec?: WorkspaceSpec
	readonly ticketId?: string
	readonly ticketUrl?: string
	readonly ticketDescription?: string
	readonly ticketProvider?: TicketProvider
	readonly githubConnectionId?: string
	readonly ticketRepositoryId?: string
	readonly ticketRepositoryFullName?: string
	readonly workflowType: 'outline_only' | 'prd_tdd' | 'oneshot'
	readonly worktreeTiming: 'now' | 'later' | 'never'
	readonly autoAdvanceQuestionsToResearch: boolean
	readonly autoAdvanceResearchToDesign: boolean
	readonly autoAdvancePlanToWorktree: boolean
	readonly autoAdvanceWorktreeToImplementation: boolean
	readonly autoAdvanceImplementationToPr: boolean
	readonly createdWithExperimentFlags?: CreatedWithExperimentFlags
	readonly attachments: readonly TaskLaunchAttachment[]
	/** Board status; a new task starts in progress, a promoted draft keeps its own. */
	readonly status?: TaskStatus
	readonly importedTicket?: PreparedTicketArtifactBundle
	/** An explicit account pick: one of the user's accounts, or null for the host's gh login. Omitted: no pick. */
	readonly githubAccountId?: string | null
	readonly firstSession: TaskLaunchFirstSession
	readonly intent?: TaskIntent
}

export type TaskLaunchOutcome = 'created' | 'promoted' | 'already-launched'

export type LaunchTaskDraftResult = {
	readonly outcome: TaskLaunchOutcome
	readonly taskId: string
	readonly firstSessionId: string
	readonly transactionId: string
	readonly task: Task
}
