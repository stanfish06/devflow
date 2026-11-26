/**
 * This file implements the implementer `os` with the methods we defined
 */

import { discoverWorkspaceAgentCommandsProcedure } from './api/agent-commands/discover-workspace.effect'
import { generateTitleProcedure } from './api/ai/generate-title'
import { resolveApprovalEffectProcedure } from './api/approvals/resolve.effect'
import { createUploadApiArtifactProcedure } from './api/artifacts/create-upload.effect'
import { getArtifactProcedure } from './api/artifacts/get.effect'
import { listArtifactsProcedure } from './api/artifacts/list.effect'
import { updateArtifactDeletionStatusProcedure } from './api/artifacts/update-deletion-status.effect'
import { upsertApiArtifactProcedure } from './api/artifacts/upsert.effect'
import { getArtifactVersionProcedure } from './api/artifacts/versions-get.effect'
import { listArtifactVersionsProcedure } from './api/artifacts/versions-list.effect'
import { getOrgSettingsEffectProcedure } from './api/auth/admin/organizations-settings-get.effect'
import { setOrgSettingsEffectProcedure } from './api/auth/admin/organizations-settings-set.effect'
import { listAdminUsersProcedure } from './api/auth/admin/users-list'
import { setAdminUserMetricsAdvancedProcedure } from './api/auth/admin/users-set-metrics-advanced'
import { createLaunchTokenProcedure } from './api/auth/daemon/launch-token-create'
import { createDaemonTokenProcedure } from './api/auth/daemon/token-create'
import { exchangeLaunchTokenProcedure } from './api/auth/daemon/token-exchange'
import { getCurrentOrganizationProcedure } from './api/auth/organizations/get-current'
import { refreshTokenProcedure } from './api/auth/token-refresh'
import { getUserInfoEffectProcedure } from './api/auth/user/info.effect'
import { listUserOrganizationsProcedure } from './api/auth/user/organizations-list'
import { createPersonalAccessTokenProcedure } from './api/auth/user/personal-access-tokens-create.effect'
import { listPersonalAccessTokensProcedure } from './api/auth/user/personal-access-tokens-list.effect'
import { revokePersonalAccessTokenProcedure } from './api/auth/user/personal-access-tokens-revoke.effect'
import { getUserSettingsEffectProcedure } from './api/auth/user/settings-get.effect'
import { updateUserSettingsEffectProcedure } from './api/auth/user/settings-update.effect'
import { automationRunPrepareProcedure } from './api/automation-run-prepare.effect'
import { createCommentProcedure } from './api/comments/create'
import { deleteCommentProcedure } from './api/comments/delete.effect'
import { editCommentProcedure } from './api/comments/edit.effect'
import { getApiCommentsProcedure } from './api/comments/get.effect'
import { publicCommentGuestIdentityProcedure } from './api/comments/public-comment-guest-identity.effect'
import { replyApiCommentProcedure } from './api/comments/reply.effect'
import { resolveCommentProcedure } from './api/comments/resolve'
import { resolveAllCommentsProcedure } from './api/comments/resolve-all'
import { resolveBatchCommentsProcedure } from './api/comments/resolve-batch.effect'
import { updateApiCommentProcedure } from './api/comments/update.effect'
import { listContextShardsProcedure } from './api/context-shards/list.effect'
import { restoreContextShardProcedure } from './api/context-shards/restore'
import { updateContextShardPreferenceProcedure } from './api/context-shards/update-preference'
import { createDiffCommentProcedure } from './api/diff-comments/create.effect'
import { deleteDiffCommentProcedure } from './api/diff-comments/delete.effect'
import { editDiffCommentProcedure } from './api/diff-comments/edit.effect'
import { replyDiffCommentProcedure } from './api/diff-comments/reply.effect'
import { resolveBatchDiffCommentsProcedure } from './api/diff-comments/resolve-batch.effect'
import { resolveDiffCommentProcedure } from './api/diff-comments/resolve.effect'
import { getOrHydrateDurableStreamSessionsProcedure } from './api/durable-streams/sessions'
import { addGithubAccountProcedure } from './api/github-accounts/add.effect'
import { listGithubAccountsProcedure } from './api/github-accounts/list.effect'
import { removeGithubAccountProcedure } from './api/github-accounts/remove.effect'
import { replaceGithubAccountTokenProcedure } from './api/github-accounts/replace-token.effect'
import { setDefaultGithubAccountProcedure } from './api/github-accounts/set-default.effect'
import { listHostAliasesEffectProcedure } from './api/hosts/alias-list.effect'
import { upsertHostAliasEffectProcedure } from './api/hosts/alias-upsert.effect'
import { deleteHostEffectProcedure } from './api/hosts/delete.effect'
import { requestHostUpdateEffectProcedure } from './api/hosts/update-request.effect'
import { createGitHubInstallUrlProcedure } from './api/integrations/github/create-install-url.effect'
import { disconnectGitHubProcedure } from './api/integrations/github/disconnect.effect'
import { getGitHubConnectionProcedure } from './api/integrations/github/get-connection.effect'
import { getGitHubIssuePreviewProcedure } from './api/integrations/github/get-issue-preview.effect'
import { getGitHubStatusProcedure } from './api/integrations/github/get-status.effect'
import { listGitHubConnectionsProcedure } from './api/integrations/github/list-connections.effect'
import { listGitHubRepositoriesProcedure } from './api/integrations/github/list-repositories.effect'
import { ensurePullRequestStreamProcedure } from './api/integrations/github/pull-requests/ensure-stream.effect'
import { listPullRequestBranchesProcedure } from './api/integrations/github/pull-requests/list-branches.effect'
import { mutatePullRequestProcedure } from './api/integrations/github/pull-requests/mutate.effect'
import { refreshGitHubConnectionProcedure } from './api/integrations/github/refresh-connection.effect'
import {
	activeUsersCollaborationInboundProcedure,
	activeUsersCollaborationOutboundProcedure,
	activeUsersCommentsProcedure,
	activeUsersSessionsProcedure,
} from './api/metrics/activeUsersCharts'
import { agentCommitsByRepoProcedure } from './api/metrics/agentCommitsByRepo'
import { costPerKlocByModelProcedure } from './api/metrics/costPerKlocByModel'
import { dailyActiveUsersProcedure } from './api/metrics/dailyActiveUsers'
import { modelSpendTrendProcedure } from './api/metrics/modelSpendTrend'
import { modeSpendTrendProcedure } from './api/metrics/modeSpendTrend'
import { mostSessionsProcedure } from './api/metrics/mostSessions'
import { rangeOverviewProcedure } from './api/metrics/rangeOverview'
import { scatterFilterOptionsProcedure } from './api/metrics/scatterFilterOptions'
import { sessionsPerDayProcedure } from './api/metrics/sessionsPerDay'
import { sessionsPerWeekProcedure } from './api/metrics/sessionsPerWeek'
import { stageSpendTrendProcedure } from './api/metrics/stageSpendTrend'
import { taskFanOutProcedure } from './api/metrics/taskFanOut'
import { tokenUseByTaskProcedure } from './api/metrics/tokenUseByTask'
import { unitCostTrendProcedure } from './api/metrics/unitCostTrend'
import { usageByModelProcedure } from './api/metrics/usageByModel'
import { usageTrendEffectProcedure } from './api/metrics/usageTrend.effect'
import { userModeSpendProcedure } from './api/metrics/userModeSpend.effect'
import { usersScatterProcedure } from './api/metrics/usersScatter'
import { userStageSpendProcedure } from './api/metrics/userStageSpend.effect'
import { weeklyActiveUsersProcedure } from './api/metrics/weeklyActiveUsers'
import { listActiveOrgMembersProcedure, listOrgMembersProcedure } from './api/org/members-list'
import { getProjectWorkspaceStatusProcedure } from './api/project-workspaces/get-status.effect'
import { recoverProjectWorkspaceRepositorySourceProcedure } from './api/project-workspaces/repository-source-recover.effect'
import { getProjectWorkspaceRepositorySourcesProcedure } from './api/project-workspaces/repository-sources-get.effect'
import { upsertProjectWorkspaceRepositorySourcesProcedure } from './api/project-workspaces/repository-sources-upsert.effect'
import { retryProjectWorkspaceRepositorySetupProcedure } from './api/project-workspaces/retry-repository-setup.effect'
import { skipProjectWorkspaceRepositorySetupStepProcedure } from './api/project-workspaces/skip-repository-setup-step.effect'
import { archiveProjectV2Procedure } from './api/projects-v2/archive.effect'
import { createProjectV2Procedure } from './api/projects-v2/create.effect'
import { projectDeletePreviewV2Procedure } from './api/projects-v2/delete-preview.effect'
import { deleteProjectV2Procedure } from './api/projects-v2/delete.effect'
import { getProjectV2Procedure } from './api/projects-v2/get.effect'
import { listProjectsV2Procedure } from './api/projects-v2/list.effect'
import { upsertProjectV2LocationProcedure } from './api/projects-v2/location-upsert.effect'
import { getProjectV2RepositorySourcesProcedure } from './api/projects-v2/repository-sources-get.effect'
import { upsertProjectV2RepositorySourcesProcedure } from './api/projects-v2/repository-sources-upsert.effect'
import { setProjectGithubAccountProcedure } from './api/projects-v2/set-github-account.effect'
import { updateProjectV2Procedure } from './api/projects-v2/update.effect'
import {
	cancelProviderLoginProcedure,
	createProviderLoginProcedure,
	listProviderLoginsProcedure,
	submitProviderLoginCodeProcedure,
} from './api/provider-login'
import { sharedArtifactCommentAuthorsProcedure } from './api/public/artifacts/comment-authors.effect'
import { createPublicArtifactCommentProcedure } from './api/public/artifacts/create-comment.effect'
import { sharedArtifactDownloadUrlProcedure } from './api/public/artifacts/download-url'
import { artifactInfoProcedure } from './api/public/artifacts/info'
import { resolveSharedArtifactProcedure } from './api/public/artifacts/resolve.effect'
import { undoPublicArtifactCommentProcedure } from './api/public/artifacts/undo-comment.effect'
import { continueSessionProcedure } from './api/sessions/continue'
import { createSessionProcedure } from './api/sessions/create'
import { listSessionEventsProcedure } from './api/sessions/events/list.effect'
import { forkSessionProcedure, forkSessionV2Procedure } from './api/sessions/fork'
import { handoffSessionProcedure } from './api/sessions/handoff'
import { interruptSessionProcedure } from './api/sessions/interrupt'
import { launchSessionProcedure } from './api/sessions/launch'
import { listSessionsEffectProcedure } from './api/sessions/list.effect'
import { updateMultiplayerPromptingEffectProcedure } from './api/sessions/multiplayer-prompting/update.effect'
import {
	createQueuedMessageEffectProcedure,
	deleteQueuedMessageEffectProcedure,
} from './api/sessions/queued-messages.effect'
import { sendNowQueuedMessageEffectProcedure } from './api/sessions/queued-messages.send-now.effect'
import { updateQueuedMessageEffectProcedure } from './api/sessions/queued-messages.update.effect'
import { relaunchSessionProcedure } from './api/sessions/relaunch'
import { updateSessionApiProcedure } from './api/sessions/update'
import { updateSessionStatusProcedure } from './api/sessions/update-status'
import { continueSessionV2Procedure } from './api/sessions/v2/continue'
import { createSessionV2Procedure } from './api/sessions/v2/create.effect'
import { updateArtifactSharingProcedure } from './api/sharing/artifact/update.effect'
import { updateOrgSharingProcedure } from './api/sharing/organization/update.effect'
import { updateUserSharingProcedure } from './api/sharing/user/update.effect'
import { syncApprovalsEffectProcedure } from './api/sync/approvals.effect'
import { syncArtifactCommentsProcedure } from './api/sync/artifact-comments'
import { syncArtifactsProcedure } from './api/sync/artifacts'
import { syncArtifactsMetadataProcedure } from './api/sync/artifacts-metadata'
import { syncConversationEventsProcedure } from './api/sync/conversation-events'
import { syncOnlineHostsProcedure } from './api/sync/online-hosts'
import { syncQueuedMessagesProcedure } from './api/sync/queued-messages'
import { syncSessionsProcedure } from './api/sync/sessions'
import { syncTaskOrganizationAclsProcedure } from './api/sync/task-organization-acls'
import { syncTaskUserAclsProcedure } from './api/sync/task-user-acls'
import { syncTaskUserSettingsProcedure } from './api/sync/task-user-settings'
import { syncTasksProcedure } from './api/sync/tasks'
import { syncV2AgentSlashCommandsEffectProcedure } from './api/sync/v2/agent-slash-commands.effect'
import { syncV2ApprovalsProcedure } from './api/sync/v2/approvals'
import { syncV2ArtifactCommentsProcedure } from './api/sync/v2/artifact-comments'
import { syncV2ArtifactsProcedure } from './api/sync/v2/artifacts'
import { syncV2ArtifactsMetadataProcedure } from './api/sync/v2/artifacts-metadata'
import { syncV2ConversationEventsProcedure } from './api/sync/v2/conversation-events'
import { syncV2DiffCommentsProcedure } from './api/sync/v2/diff-comments'
import { syncV2OnlineHostsProcedure } from './api/sync/v2/online-hosts'
import { syncV2ProviderLoginRequestsProcedure } from './api/sync/v2/provider-login-requests'
import { syncV2QueuedMessagesProcedure } from './api/sync/v2/queued-messages'
import { syncV2SessionsProcedure } from './api/sync/v2/sessions'
import { syncV2TaskOrganizationAclsProcedure } from './api/sync/v2/task-organization-acls'
import { syncV2TaskUserAclsProcedure } from './api/sync/v2/task-user-acls'
import { syncV2TaskUserSettingsProcedure } from './api/sync/v2/task-user-settings'
import { syncV2TaskWorkspaceSetupForHostProcedure } from './api/sync/v2/task-workspace-setup-for-host'
import { syncV2TasksProcedure } from './api/sync/v2/tasks'
import { upsertTaskUserSettingsProcedure } from './api/task-user-settings/upsert.effect'
import { archiveTaskProcedure } from './api/tasks/archive'
import { createTaskProcedure } from './api/tasks/create'
import { createTaskDraftEffectProcedure } from './api/tasks/createDraft.effect'
import { deleteArchivedTasksPreviewProcedure } from './api/tasks/delete-archived-preview.effect'
import { deleteArchivedTasksProcedure } from './api/tasks/delete-archived.effect'
import { deleteTaskEffectProcedure } from './api/tasks/delete.effect'
import { launchTaskDraftProcedure } from './api/tasks/launch-draft'
import { listTasksProcedure } from './api/tasks/list.effect'
import { reassignTaskOwnerProcedure } from './api/tasks/reassign-owner'
import { saveTaskDraftProcedure } from './api/tasks/saveDraft'
import { setTaskGithubAccountProcedure } from './api/tasks/set-github-account.effect'
import { updateTaskProcedure } from './api/tasks/update'
import { createTaskV2Procedure } from './api/tasks/v2/create.effect'
import { createUploadProcedure } from './api/uploads/create.effect'
import { getDownloadUrlProcedure } from './api/uploads/download-url.effect'
import { getPresignedUrlProcedure } from './api/uploads/get-presigned-url.effect'
import { upsertTextArtifactProcedure } from './api/uploads/upsert-text.effect'
import { getPresignedUrlV2Procedure } from './api/uploads/v2/get-presigned-url.effect'
import { usageDayProcedure } from './api/usage/day.effect'
import { usagePeriodProcedure } from './api/usage/period.effect'
import { usageYearProcedure } from './api/usage/year.effect'
import { retryWorkspaceSetupStepProcedure } from './api/workspace-setup/retry-step'
import { skipWorkspaceSetupStepProcedure } from './api/workspace-setup/skip-step'
import { updateWorkspaceSetupRepositoryDirectoryProcedure } from './api/workspace-setup/update-repository-directory'
import { daemonBase, os } from './base'
import { reportAgentCommandsProcedure } from './daemon/agent-commands/report.effect'
import { researchProcedure } from './daemon/agents/research'
import { createApprovalProcedure } from './daemon/approvals/create'
import { daemonCreateUploadProcedure } from './daemon/artifacts/create-upload'
import { getDaemonDownloadUrlProcedure } from './daemon/artifacts/download-url'
import { upsertArtifactProcedure } from './daemon/artifacts/upsert'
import { getCommentsProcedure } from './daemon/comments/get'
import { replyCommentProcedure } from './daemon/comments/reply'
import { updateCommentProcedure } from './daemon/comments/update'
import { recordObservedCommitsProcedure } from './daemon/commits/record-observed.effect'
import { getCommitWatermarksProcedure, setCommitWatermarkProcedure } from './daemon/commits/watermark.effect'
import { daemonListEnabledContextShardsProcedure } from './daemon/context-shards/list-enabled.effect'
import { getDiffCommentsProcedure } from './daemon/diff-comments/get.effect'
import { replyToDiffCommentProcedure } from './daemon/diff-comments/reply.effect'
import { updateDiffCommentsProcedure } from './daemon/diff-comments/update.effect'
import { reportGithubRejectionProcedure } from './daemon/github-accounts/report-rejection.effect'
import { resolveGithubTokenProcedure } from './daemon/github-accounts/resolve-token.effect'
import { heartbeatEffectProcedure } from './daemon/hosts/heartbeat.effect'
import { shutdownEffectProcedure } from './daemon/hosts/shutdown.effect'
import { syncGitHubArtifactBacklinkProcedure } from './daemon/integrations/github/sync-artifact-backlink.effect'
import { getWorkspaceRepositoryStatusProcedure } from './daemon/project-workspaces/get-repository-status.effect'
import { getSessionWorkspaceSetupProcedure } from './daemon/project-workspaces/get-session-workspace-setup.effect'
import { getTaskWorkspaceContextProcedure } from './daemon/project-workspaces/get-task-workspace-context.effect'
import { advanceRepositorySetupStageProcedure } from './daemon/project-workspaces/report-repository-result.effect'
import { updateDaemonProviderLoginProcedure } from './daemon/provider-login/update'
import { listOpenPullRequestsForHostProcedure } from './daemon/pull-requests/list-open-for-host.effect'
import { refreshPullRequestStatusProcedure } from './daemon/pull-requests/refresh-status.effect'
import { recordCommitsProcedure } from './daemon/sessions/commits/record.effect'
import { ensureStreamHydratedProcedure } from './daemon/sessions/ensure-stream-hydrated'
import { createEventProcedure } from './daemon/sessions/events/create'
import { upsertSessionPullRequestProcedure } from './daemon/sessions/pull-requests/upsert.effect'
import { reportSessionRepositoriesProcedure } from './daemon/sessions/repositories/report.effect'
import { updateSessionProcedure } from './daemon/sessions/update'
import { recordSessionUsageEffectProcedure } from './daemon/sessions/usage/record.effect'
import { workflowSkillProcedure } from './daemon/sessions/workflow-skill'
import { daemonGetSettingsEffectProcedure } from './daemon/settings/get.effect'
import { syncDaemonApprovalsProcedure } from './daemon/sync/approvals'
import { syncDaemonArtifactsProcedure } from './daemon/sync/artifacts'
import { syncDaemonSessionsProcedure } from './daemon/sync/sessions'
import { syncDaemonTaskWorkspaceSetupForHostProcedure } from './daemon/sync/task-workspace-setup-for-host'
import { syncDaemonTasksProcedure } from './daemon/sync/tasks'
import { setGithubIdentityProcedure } from './daemon/users/set-github-identity.effect'
import { updateDaemonWorkspaceSetupProcedure } from './daemon/workspace-setup/update'

export const apiRouter = os.router({
	public: {
		artifacts: {
			info: artifactInfoProcedure,
			downloadUrl: sharedArtifactDownloadUrlProcedure,
			resolve: resolveSharedArtifactProcedure,
			commentAuthors: sharedArtifactCommentAuthorsProcedure,
			createComment: createPublicArtifactCommentProcedure,
			undoComment: undoPublicArtifactCommentProcedure,
		},
	},
	metrics: {
		activeUsersCollaborationInbound: activeUsersCollaborationInboundProcedure,
		activeUsersCollaborationOutbound: activeUsersCollaborationOutboundProcedure,
		activeUsersComments: activeUsersCommentsProcedure,
		activeUsersSessions: activeUsersSessionsProcedure,
		agentCommitsByRepo: agentCommitsByRepoProcedure,
		costPerKlocByModel: costPerKlocByModelProcedure,
		modeSpendTrend: modeSpendTrendProcedure,
		modelSpendTrend: modelSpendTrendProcedure,
		unitCostTrend: unitCostTrendProcedure,
		dailyActiveUsers: dailyActiveUsersProcedure,
		mostSessions: mostSessionsProcedure,
		rangeOverview: rangeOverviewProcedure,
		scatterFilterOptions: scatterFilterOptionsProcedure,
		sessionsPerDay: sessionsPerDayProcedure,
		sessionsPerWeek: sessionsPerWeekProcedure,
		stageSpendTrend: stageSpendTrendProcedure,
		taskFanOut: taskFanOutProcedure,
		tokenUseByTask: tokenUseByTaskProcedure,
		usageByModel: usageByModelProcedure,
		usageTrend: usageTrendEffectProcedure,
		usersScatter: usersScatterProcedure,
		userStageSpend: userStageSpendProcedure,
		userModeSpend: userModeSpendProcedure,
		weeklyActiveUsers: weeklyActiveUsersProcedure,
	},
	usage: {
		year: usageYearProcedure,
		period: usagePeriodProcedure,
		day: usageDayProcedure,
	},
	automation: {
		run: {
			prepare: automationRunPrepareProcedure,
		},
	},
	auth: {
		user: {
			info: getUserInfoEffectProcedure,
			personalAccessTokens: {
				create: createPersonalAccessTokenProcedure,
				list: listPersonalAccessTokensProcedure,
				revoke: revokePersonalAccessTokenProcedure,
			},
			settings: {
				get: getUserSettingsEffectProcedure,
				update: updateUserSettingsEffectProcedure,
			},
			organizations: {
				list: listUserOrganizationsProcedure,
			},
		},
		organizations: {
			getCurrent: getCurrentOrganizationProcedure,
		},

		admin: {
			users: {
				list: listAdminUsersProcedure,
				setMetricsAdvancedEnabled: setAdminUserMetricsAdvancedProcedure,
			},
			organizations: {
				settings: {
					get: getOrgSettingsEffectProcedure,
					set: setOrgSettingsEffectProcedure,
				},
			},
		},
		token: {
			refresh: refreshTokenProcedure,
		},
		daemon: {
			token: {
				create: createDaemonTokenProcedure,
				exchange: exchangeLaunchTokenProcedure,
			},
			launchToken: {
				create: createLaunchTokenProcedure,
			},
		},
	},
	sessions: {
		create: createSessionProcedure,
		fork: forkSessionProcedure,
		handoff: handoffSessionProcedure,
		v2: {
			fork: forkSessionV2Procedure,
			continue: continueSessionV2Procedure,
			create: createSessionV2Procedure,
		},
		launch: launchSessionProcedure,
		update: updateSessionApiProcedure,
		updateStatus: updateSessionStatusProcedure,
		continue: continueSessionProcedure,
		interrupt: interruptSessionProcedure,
		relaunch: relaunchSessionProcedure,
		list: listSessionsEffectProcedure,
		multiplayerPrompting: { update: updateMultiplayerPromptingEffectProcedure },
		events: {
			list: listSessionEventsProcedure,
		},
		queuedMessages: {
			create: createQueuedMessageEffectProcedure,
			update: updateQueuedMessageEffectProcedure,
			delete: deleteQueuedMessageEffectProcedure,
			sendNow: sendNowQueuedMessageEffectProcedure,
		},
	},
	tasks: {
		create: createTaskProcedure,
		createDraft: createTaskDraftEffectProcedure,
		launchDraft: launchTaskDraftProcedure,
		saveDraft: saveTaskDraftProcedure,
		update: updateTaskProcedure,
		reassignOwner: reassignTaskOwnerProcedure,
		archive: archiveTaskProcedure,
		delete: deleteTaskEffectProcedure,
		deleteArchivedPreview: deleteArchivedTasksPreviewProcedure,
		deleteArchived: deleteArchivedTasksProcedure,
		setGithubAccount: setTaskGithubAccountProcedure,
		list: listTasksProcedure,
		v2: {
			create: createTaskV2Procedure,
		},
	},
	projects: {
		v2: {
			list: listProjectsV2Procedure,
			get: getProjectV2Procedure,
			create: createProjectV2Procedure,
			update: updateProjectV2Procedure,
			archive: archiveProjectV2Procedure,
			deletePreview: projectDeletePreviewV2Procedure,
			delete: deleteProjectV2Procedure,
			setGithubAccount: setProjectGithubAccountProcedure,
			locations: { upsert: upsertProjectV2LocationProcedure },
			repositorySources: {
				get: getProjectV2RepositorySourcesProcedure,
				upsert: upsertProjectV2RepositorySourcesProcedure,
			},
		},
	},
	projectWorkspaces: {
		getStatus: getProjectWorkspaceStatusProcedure,
		repositorySources: {
			get: getProjectWorkspaceRepositorySourcesProcedure,
			upsert: upsertProjectWorkspaceRepositorySourcesProcedure,
			recover: recoverProjectWorkspaceRepositorySourceProcedure,
		},
		retryRepositorySetup: retryProjectWorkspaceRepositorySetupProcedure,
		skipRepositorySetupStep: skipProjectWorkspaceRepositorySetupStepProcedure,
	},
	organization: {
		members: {
			list: listOrgMembersProcedure,
			listActive: listActiveOrgMembersProcedure,
		},
	},
	sharing: {
		organization: {
			update: updateOrgSharingProcedure,
		},
		user: {
			update: updateUserSharingProcedure,
		},
		artifact: {
			update: updateArtifactSharingProcedure,
		},
	},
	approvals: {
		resolve: resolveApprovalEffectProcedure,
	},
	durableStreams: {
		sessions: {
			getOrHydrate: getOrHydrateDurableStreamSessionsProcedure,
		},
	},
	comments: {
		get: getApiCommentsProcedure,
		update: updateApiCommentProcedure,
		reply: replyApiCommentProcedure,
		create: createCommentProcedure,
		resolve: resolveCommentProcedure,
		resolveAll: resolveAllCommentsProcedure,
		resolveBatch: resolveBatchCommentsProcedure,
		delete: deleteCommentProcedure,
		edit: editCommentProcedure,
		publicCommentGuestIdentity: publicCommentGuestIdentityProcedure,
	},
	diffComments: {
		create: createDiffCommentProcedure,
		reply: replyDiffCommentProcedure,
		edit: editDiffCommentProcedure,
		delete: deleteDiffCommentProcedure,
		resolve: resolveDiffCommentProcedure,
		resolveBatch: resolveBatchDiffCommentsProcedure,
	},
	artifacts: {
		list: listArtifactsProcedure,
		get: getArtifactProcedure,
		versions: {
			list: listArtifactVersionsProcedure,
			get: getArtifactVersionProcedure,
		},
		upsert: upsertApiArtifactProcedure,
		createUpload: createUploadApiArtifactProcedure,
		updateDeletionStatus: updateArtifactDeletionStatusProcedure,
	},
	taskUserSettings: {
		upsert: upsertTaskUserSettingsProcedure,
	},
	contextShards: {
		list: listContextShardsProcedure,
		updatePreference: updateContextShardPreferenceProcedure,
		restore: restoreContextShardProcedure,
	},
	workspaceSetup: {
		retryStep: retryWorkspaceSetupStepProcedure,
		skipStep: skipWorkspaceSetupStepProcedure,
		updateRepositoryDirectory: updateWorkspaceSetupRepositoryDirectoryProcedure,
	},
	providerLogin: {
		create: createProviderLoginProcedure,
		submitCode: submitProviderLoginCodeProcedure,
		cancel: cancelProviderLoginProcedure,
		list: listProviderLoginsProcedure,
	},
	agentCommands: {
		discoverWorkspace: discoverWorkspaceAgentCommandsProcedure,
	},
	ai: {
		generateTitle: generateTitleProcedure,
	},
	sync: {
		sessions: syncSessionsProcedure,
		tasks: syncTasksProcedure,
		conversationEvents: syncConversationEventsProcedure,
		approvals: syncApprovalsEffectProcedure,
		artifactComments: syncArtifactCommentsProcedure,
		artifacts: syncArtifactsProcedure,
		artifactsMetadata: syncArtifactsMetadataProcedure,
		queuedMessages: syncQueuedMessagesProcedure,
		v2: {
			sessions: syncV2SessionsProcedure,
			tasks: syncV2TasksProcedure,
			conversationEvents: syncV2ConversationEventsProcedure,
			approvals: syncV2ApprovalsProcedure,
			artifactComments: syncV2ArtifactCommentsProcedure,
			diffComments: syncV2DiffCommentsProcedure,
			artifacts: syncV2ArtifactsProcedure,
			artifactsMetadata: syncV2ArtifactsMetadataProcedure,
			queuedMessages: syncV2QueuedMessagesProcedure,
			taskOrganizationAcls: syncV2TaskOrganizationAclsProcedure,
			taskUserAcls: syncV2TaskUserAclsProcedure,
			taskUserSettings: syncV2TaskUserSettingsProcedure,
			taskWorkspaceSetupForHost: syncV2TaskWorkspaceSetupForHostProcedure,
			onlineHosts: syncV2OnlineHostsProcedure,
			agentSlashCommands: syncV2AgentSlashCommandsEffectProcedure,
			providerLoginRequests: syncV2ProviderLoginRequestsProcedure,
		},
		onlineHosts: syncOnlineHostsProcedure,
		taskOrganizationAcls: syncTaskOrganizationAclsProcedure,
		taskUserAcls: syncTaskUserAclsProcedure,
		taskUserSettings: syncTaskUserSettingsProcedure,
	},
	uploads: {
		create: createUploadProcedure,
		getPresignedUrl: getPresignedUrlProcedure,
		downloadUrl: getDownloadUrlProcedure,
		upsertText: upsertTextArtifactProcedure,
		v2: {
			getPresignedUrl: getPresignedUrlV2Procedure,
		},
	},
	integrations: {
		github: {
			createInstallUrl: createGitHubInstallUrlProcedure,
			getStatus: getGitHubStatusProcedure,
			listConnections: listGitHubConnectionsProcedure,
			getConnection: getGitHubConnectionProcedure,
			getIssuePreview: getGitHubIssuePreviewProcedure,
			listRepositories: listGitHubRepositoriesProcedure,
			refreshConnection: refreshGitHubConnectionProcedure,
			disconnect: disconnectGitHubProcedure,
			pullRequests: {
				ensureStream: ensurePullRequestStreamProcedure,
				listPullRequestBranches: listPullRequestBranchesProcedure,
				mutate: mutatePullRequestProcedure,
			},
		},
	},
	hosts: {
		delete: deleteHostEffectProcedure,
		alias: {
			upsert: upsertHostAliasEffectProcedure,
			list: listHostAliasesEffectProcedure,
		},
		update: {
			request: requestHostUpdateEffectProcedure,
		},
	},
	githubAccounts: {
		list: listGithubAccountsProcedure,
		add: addGithubAccountProcedure,
		replaceToken: replaceGithubAccountTokenProcedure,
		remove: removeGithubAccountProcedure,
		setDefault: setDefaultGithubAccountProcedure,
	},
})

export const daemonRouter = daemonBase.router({
	workspaceSetup: { update: updateDaemonWorkspaceSetupProcedure },
	providerLogin: { update: updateDaemonProviderLoginProcedure },
	hosts: {
		heartbeat: heartbeatEffectProcedure,
		shutdown: shutdownEffectProcedure,
	},
	comments: {
		get: getCommentsProcedure,
		update: updateCommentProcedure,
		reply: replyCommentProcedure,
	},
	diffComments: {
		get: getDiffCommentsProcedure,
		update: updateDiffCommentsProcedure,
		reply: replyToDiffCommentProcedure,
	},
	sessions: {
		events: {
			create: createEventProcedure,
		},
		commits: {
			record: recordCommitsProcedure,
		},
		usage: {
			record: recordSessionUsageEffectProcedure,
		},
		pullRequests: {
			upsert: upsertSessionPullRequestProcedure,
		},
		repositories: {
			report: reportSessionRepositoriesProcedure,
		},
		update: updateSessionProcedure,
		ensureStreamHydrated: ensureStreamHydratedProcedure,
		workflowSkill: workflowSkillProcedure,
	},
	commits: {
		recordObserved: recordObservedCommitsProcedure,
		watermark: {
			get: getCommitWatermarksProcedure,
			set: setCommitWatermarkProcedure,
		},
	},
	pullRequests: {
		listOpenForHost: listOpenPullRequestsForHostProcedure,
		refreshStatus: refreshPullRequestStatusProcedure,
	},
	projectWorkspaces: {
		getRepositoryStatus: getWorkspaceRepositoryStatusProcedure,
		getSessionWorkspaceSetup: getSessionWorkspaceSetupProcedure,
		getTaskWorkspaceContext: getTaskWorkspaceContextProcedure,
		reportRepositoryResult: advanceRepositorySetupStageProcedure,
	},
	users: {
		setGithubIdentity: setGithubIdentityProcedure,
	},
	githubAccounts: {
		resolveToken: resolveGithubTokenProcedure,
		reportRejection: reportGithubRejectionProcedure,
	},
	approvals: {
		create: createApprovalProcedure,
	},
	agents: {
		research: researchProcedure,
	},
	agentCommands: {
		report: reportAgentCommandsProcedure,
	},
	artifacts: {
		upsert: upsertArtifactProcedure,
		downloadUrl: getDaemonDownloadUrlProcedure,
		createUpload: daemonCreateUploadProcedure,
	},
	settings: {
		get: daemonGetSettingsEffectProcedure,
	},
	contextShards: {
		listEnabled: daemonListEnabledContextShardsProcedure,
	},
	sync: {
		sessions: syncDaemonSessionsProcedure,
		approvals: syncDaemonApprovalsProcedure,
		tasks: syncDaemonTasksProcedure,
		artifacts: syncDaemonArtifactsProcedure,
		taskWorkspaceSetupForHost: syncDaemonTaskWorkspaceSetupForHostProcedure,
	},
	integrations: {
		github: {
			syncArtifactBacklink: syncGitHubArtifactBacklinkProcedure,
		},
	},
})
