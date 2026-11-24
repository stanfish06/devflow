import type { ResolvedTaskWorkflow } from '@devflow/schemas/effect/taskconfiguration'
import { useLocalStorage } from '@uidotdev/usehooks'

export type TaskSize = 'small' | 'medium' | 'large' | 'unknown'

type TaskSizeOption = { value: TaskSize; label: string; description: string; workflow: ResolvedTaskWorkflow }

const UNKNOWN_SIZE: TaskSizeOption = {
	value: 'unknown',
	label: "Don't know yet",
	description: 'Explore a question, issue, or feature request',
	workflow: { workflowType: 'freeform', autoAdvance: false },
}

/**
 * How big the new task is, and the workflow each size launches. Small work and work you can't size
 * yet start freeform from the prompt; small work also aims at a pull request. Medium runs RPI and
 * large runs PRD / TDD, both auto-advancing.
 */
export const TASK_SIZES: readonly TaskSizeOption[] = [
	{
		value: 'small',
		label: 'Small',
		description: 'Jump to implementation and prepare a pull request',
		workflow: { workflowType: 'freeform', autoAdvance: true },
	},
	{
		value: 'medium',
		label: 'Medium',
		description: 'Research and outline the work before implementation (RPI)',
		workflow: { workflowType: 'outline_only', autoAdvance: true },
	},
	{
		value: 'large',
		label: 'Large',
		description: 'Define product and technical design before implementation (PRD-TDD)',
		workflow: { workflowType: 'prd_tdd', autoAdvance: true },
	},
	UNKNOWN_SIZE,
]

export function taskSizeOption(size: TaskSize): TaskSizeOption {
	return TASK_SIZES.find((option) => option.value === size) ?? UNKNOWN_SIZE
}

/** The size new tasks start with: the last one picked on this device. */
export function useTaskSize() {
	return useLocalStorage<TaskSize>('hl-min-task-size', 'unknown')
}

/** Whether a small task describes its pull request on its own once implementation is done. */
export function useSmallTaskAutoAdvance() {
	return useLocalStorage<boolean>('hl-min-small-auto-advance', true)
}

/** The workflow a new task of this size launches with. */
export function taskSizeWorkflow(size: TaskSize, smallAutoAdvance: boolean): ResolvedTaskWorkflow {
	const { workflow } = taskSizeOption(size)
	return size === 'small' ? { workflowType: workflow.workflowType, autoAdvance: smallAutoAdvance } : workflow
}
