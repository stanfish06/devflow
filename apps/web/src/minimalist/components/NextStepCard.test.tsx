import type { Session } from '@devflow/db/tables/sessions'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NextStepCard } from './NextStepCard'

const { navigate, sibling } = vi.hoisted(() => ({ navigate: vi.fn(), sibling: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: {} }) }))
vi.mock('@/minimalist/lib/use-action', () => ({ useAction: () => ({ pending: false, run: vi.fn() }) }))
vi.mock('@/hooks/live-queries/useExistingSessionForNextStep', () => ({
	useExistingSessionForNextStep: sibling,
}))

const session = (id: string) =>
	({
		id,
		task_id: 'task',
		host_id: 'host',
		working_directory: '/repo',
		created_at: new Date(0),
		next_step_suggestions: [
			{
				parsedAt: 0,
				extraction: {
					type: 'next_step_found',
					nextStepPrompt: 'use the rpi:create-plan skill for the task',
					nextStepSummary: 'Proceed to the plan',
					nextStepType: 'create-plan',
					taskReference: 'task',
				},
			},
		],
	}) as unknown as Session

const task = { id: 'task', workspace_id: null }
const host = { online: true } as Parameters<typeof NextStepCard>[0]['host']

beforeEach(() => {
	localStorage.clear()
	navigate.mockClear()
	sibling.mockReturnValue({ siblingSessionId: null })
})
afterEach(cleanup)

describe('NextStepCard', () => {
	it('opens the TDD that Devflow started from the Codex PRD', () => {
		const prd = session('prd')
		prd.provider = 'codex'
		prd.next_step_suggestions = [
			{
				parsedAt: 1,
				extraction: {
					type: 'next_step_found',
					nextStepType: 'create-tdd',
					nextStepSummary: 'Create TDD',
					nextStepPrompt: '/rpi:create-tdd for .devflow/tasks/example',
					taskReference: '.devflow/tasks/example',
				},
			},
		]
		sibling.mockReturnValue({ siblingSessionId: 'tdd' })
		render(<NextStepCard session={prd} task={task} host={null} />)
		expect(sibling).toHaveBeenCalledWith(task.id, 'rpi:design-tdd', prd.created_at, prd.id)
		fireEvent.click(screen.getByRole('button', { name: /Open TDD/ }))
		expect(navigate).toHaveBeenCalledWith({
			to: '/tasks/$taskId',
			params: { taskId: task.id },
			search: { session: 'tdd' },
		})
	})
	it('folds into a thin row for that session and opens again from it', () => {
		const { rerender } = render(<NextStepCard session={session('a')} task={task} host={host} />)
		expect(screen.getByRole('group', { name: 'Next step' })).toHaveTextContent('Write the plan')
		fireEvent.click(screen.getByRole('button', { name: 'Hide next step' }))
		expect(screen.queryByRole('group', { name: 'Next step' })).toBeNull()
		const row = screen.getByRole('button', { name: 'Show next step: Write the plan' })

		// Another session still shows its card; coming back keeps this one folded.
		rerender(<NextStepCard session={session('b')} task={task} host={host} />)
		expect(screen.getByRole('group', { name: 'Next step' })).toBeInTheDocument()
		rerender(<NextStepCard session={session('a')} task={task} host={host} />)
		fireEvent.click(screen.getByRole('button', { name: 'Show next step: Write the plan' }))
		expect(screen.getByRole('group', { name: 'Next step' })).toBeInTheDocument()
		expect(row.isConnected).toBe(false)
	})
})
