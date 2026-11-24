import { Effect } from 'effect'

import type { WorkspaceSetupExecutorError } from './workspace-setup-executor.errors'
import type { WorkspaceRepoOperationInput } from './workspace-setup-executor.types'

export const workspaceSetupOperationAttributes = (input: WorkspaceRepoOperationInput, stage: string) => ({
	task_id: input.taskId,
	host_id: input.hostId,
	local_path: input.repo.localPath,
	stage,
})

export const observeWorkspaceSetupExecutorFailure = (error: WorkspaceSetupExecutorError) =>
	Effect.logError(error).pipe(
		Effect.annotateLogs({
			task_id: error.taskId,
			host_id: error.hostId,
			local_path: error.localPath,
			stage: error.stage,
			error_type: error._tag,
		}),
	)
