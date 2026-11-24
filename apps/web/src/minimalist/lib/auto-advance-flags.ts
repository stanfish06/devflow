import type {
	ResolvedTaskWorkflow,
	TaskAutoAdvanceFlags,
	WorktreeTiming,
} from '@devflow/schemas/effect/taskconfiguration'

/**
 * The task's auto-advance flags for a workflow. Guided workflows (RPI and PRD / TDD) advance
 * through research and design, and into implementation once a later worktree is set up;
 * oneshot and freeform advance from implementation to the pull request.
 */
export function projectTaskAutoAdvanceFlags(
	workflow: ResolvedTaskWorkflow,
	worktreeTiming: WorktreeTiming,
): TaskAutoAdvanceFlags {
	const guided = workflow.workflowType === 'outline_only' || workflow.workflowType === 'prd_tdd'
	return {
		autoAdvanceQuestionsToResearch: workflow.autoAdvance && guided,
		autoAdvanceResearchToDesign: workflow.autoAdvance && guided,
		autoAdvancePlanToWorktree: false,
		autoAdvanceWorktreeToImplementation: workflow.autoAdvance && guided && worktreeTiming === 'later',
		autoAdvanceImplementationToPr:
			workflow.autoAdvance && (workflow.workflowType === 'oneshot' || workflow.workflowType === 'freeform'),
	}
}
