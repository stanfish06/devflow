import type { Session } from '@devflow/db/tables/sessions'
import type { TaskWorkflowType, WorktreeTiming } from '@devflow/schemas/effect/taskconfiguration'
import type { WorkflowPhase, WorkflowSession } from '@devflow/ui/components/workflow-graph'

import { mostRecentlyActiveSession } from '@/lib/activitySorting'

const WORKFLOW_PHASE_MAP: Record<TaskWorkflowType, WorkflowPhase[]> = {
	rpi: [
		{ name: 'rpi:research-questions', title: 'questions' },
		{ name: 'rpi:research', title: 'research' },
		{ name: 'rpi:design', title: 'design' },
		{ name: 'rpi:structure', title: 'outline' },
		{ name: 'rpi:plan', title: 'plan' },
		{ name: 'rpi:implementation', title: 'implement' },
		{ name: 'rpi:describe-pr', title: 'PR' },
	],
	outline_only: [
		{ name: 'rpi:research-questions', title: 'questions' },
		{ name: 'rpi:research', title: 'research' },
		{ name: 'rpi:design', title: 'design' },
		{ name: 'rpi:structure', title: 'outline' },
		{ name: 'rpi:implementation', title: 'implement' },
		{ name: 'rpi:describe-pr', title: 'PR' },
	],
	prd_tdd: [
		{ name: 'rpi:research-questions', title: 'questions' },
		{ name: 'rpi:research', title: 'research' },
		{ name: 'rpi:design-prd', title: 'PRD' },
		{ name: 'rpi:design-tdd', title: 'TDD' },
		{ name: 'rpi:structure', title: 'outline' },
		{ name: 'rpi:implementation', title: 'implement' },
		{ name: 'rpi:describe-pr', title: 'PR' },
	],
	oneshot: [],
}

const WORKTREE_PHASE: WorkflowPhase = { name: 'rpi:worktree-setup', title: 'worktree' }
const SYNTHETIC_WORKTREE_PHASE: WorkflowPhase = {
	name: 'worktree-setup',
	title: 'worktree',
	synthetic: true,
}

export function getWorkflowPhases(
	workflowType: TaskWorkflowType | null,
	worktreeTiming: WorktreeTiming | null,
): WorkflowPhase[] {
	if (!workflowType) return []

	const basePhases = WORKFLOW_PHASE_MAP[workflowType] ?? []
	if (basePhases.length === 0) return []
	const effectiveWorktreeTiming = worktreeTiming ?? 'later'

	if (effectiveWorktreeTiming === 'now') {
		return [SYNTHETIC_WORKTREE_PHASE, ...basePhases]
	}

	if (effectiveWorktreeTiming === 'later') {
		const implementationIndex = basePhases.findIndex((phase) => phase.name === 'rpi:implementation')
		if (implementationIndex === -1) return basePhases

		return [...basePhases.slice(0, implementationIndex), WORKTREE_PHASE, ...basePhases.slice(implementationIndex)]
	}

	return basePhases
}

type WorkflowSessionRow = Pick<Session, 'id' | 'title' | 'status' | 'labels' | 'archived' | 'last_activity_at'>

export function toWorkflowSessions(
	rows: readonly WorkflowSessionRow[],
	phases: readonly WorkflowPhase[],
): WorkflowSession[] {
	const phaseNames = phases.map((phase) => phase.name)
	const nodes = rows.flatMap((row) => {
		let phaseIndex = -1
		for (const label of row.labels ?? []) {
			phaseIndex = Math.max(phaseIndex, phaseNames.indexOf(label.name))
		}
		const phase = phases[phaseIndex]
		return phase ? [{ row, phase }] : []
	})
	const current = mostRecentlyActiveSession(nodes.flatMap(({ row }) => (row.archived ? [] : [row])))
	return nodes.map(({ row, phase }) => ({
		id: row.id,
		title: row.title ?? undefined,
		status: row.status,
		labelName: phase.name,
		labelTitle: phase.title,
		artifacts: [],
		isCurrentStage: row.id === current?.id,
	}))
}
