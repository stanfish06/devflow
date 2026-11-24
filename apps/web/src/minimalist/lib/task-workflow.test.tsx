import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TASK_WORKFLOWS, useTaskWorkflow, workflowOption } from './task-workflow'

const { state, update } = vi.hoisted(() => ({
	state: {
		task: {} as Record<string, unknown>,
		autoAdvanceOn: true,
	},
	update: vi.fn(() => Promise.resolve({ success: true })),
}))
vi.mock('@/minimalist/lib/data', () => ({ useTask: () => ({ task: state.task }) }))
vi.mock('@/minimalist/lib/auto-advance', () => ({ useTaskAutoAdvance: () => ({ on: state.autoAdvanceOn }) }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: { tasks: { update } } }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast: vi.fn() }) }))

beforeEach(() => {
	vi.clearAllMocks()
	state.task = { id: 'task', workflow_type: 'oneshot', worktree_timing: 'now', resource_owner_user_id: 'me' }
	state.autoAdvanceOn = true
})

describe('workflow options', () => {
	it('names legacy rpi tasks RPI and lists oneshot, RPI and PRD-TDD', () => {
		expect(workflowOption('rpi').label).toBe('RPI')
		expect(TASK_WORKFLOWS.map((option) => option.value)).toEqual(['oneshot', 'outline_only', 'prd_tdd'])
	})
})

describe('useTaskWorkflow', () => {
	it('switches the workflow and keeps auto-advance on for the new hand-offs', async () => {
		const { result } = renderHook(() => useTaskWorkflow('task'))
		expect(result.current).toMatchObject({ current: 'oneshot', canChange: true })
		await result.current.change('outline_only')
		expect(update).toHaveBeenCalledWith({
			taskId: 'task',
			workflowType: 'outline_only',
			autoAdvanceQuestionsToResearch: true,
			autoAdvanceResearchToDesign: true,
			autoAdvancePlanToWorktree: false,
			autoAdvanceWorktreeToImplementation: false,
			autoAdvanceImplementationToPr: false,
		})
	})

	it('only lets the owner change it', () => {
		state.task = { ...state.task, resource_owner_user_id: 'someone-else' }
		const { result } = renderHook(() => useTaskWorkflow('task'))
		expect(result.current.canChange).toBe(false)
	})
})
