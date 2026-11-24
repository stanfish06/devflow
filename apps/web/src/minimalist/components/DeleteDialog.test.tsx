import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DeleteDialog } from './DeleteDialog'

// jsdom has no modal dialogs; the dialog only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { api, navigate, showToast, open } = vi.hoisted(() => ({
	api: { tasks: { delete: vi.fn() } },
	navigate: vi.fn(),
	showToast: vi.fn(),
	open: { taskId: undefined as string | undefined },
}))

vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: api }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/minimalist/lib/data', () => ({ useOpenTaskId: () => open.taskId }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))

const target = { kind: 'task', taskId: 'task-1', title: 'Fix host chip' } as const

function renderDialog() {
	const onClose = vi.fn()
	render(<DeleteDialog target={target} onClose={onClose} />)
	return { onClose }
}

const pressCommandEnter = () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true })

beforeEach(() => {
	api.tasks.delete.mockResolvedValue({ taskId: 'task-1' })
	open.taskId = undefined
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('DeleteDialog for a task', () => {
	it('names the task and says what goes and what stays', () => {
		renderDialog()
		expect(screen.getByRole('heading', { name: 'Delete “Fix host chip”?' })).toBeTruthy()
		expect(
			screen.getByText(/permanently deletes the task with its sessions, conversations, comments and artifacts/),
		).toBeTruthy()
		expect(screen.getByText(/stops any agent still running on it/)).toBeTruthy()
		expect(
			screen.getByText('Its worktree and branch on your hosts are kept. Nothing on GitHub changes.'),
		).toBeTruthy()
		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Delete task'])
		expect(screen.getByRole('button', { name: 'Delete task' }).className).toContain('danger')
	})

	it('deletes on ⌘↵, confirms with a toast without Undo, and closes', async () => {
		const { onClose } = renderDialog()
		pressCommandEnter()
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(api.tasks.delete).toHaveBeenCalledWith({ taskId: 'task-1' })
		expect(showToast).toHaveBeenCalledWith('Task deleted')
		expect(navigate).not.toHaveBeenCalled()
	})

	it('leaves the page first when the deleted task is the one open', async () => {
		open.taskId = 'task-1'
		const { onClose } = renderDialog()
		fireEvent.click(screen.getByRole('button', { name: 'Delete task' }))
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(navigate).toHaveBeenCalledWith({ to: '/' })
	})

	it('shows a failure inside the dialog and stays open', async () => {
		api.tasks.delete.mockRejectedValue(new Error('FORBIDDEN'))
		const { onClose } = renderDialog()
		pressCommandEnter()
		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not delete the task. Try again.'))
		expect(onClose).not.toHaveBeenCalled()
		expect(showToast).not.toHaveBeenCalled()
	})

	it('cancels without deleting', () => {
		const { onClose } = renderDialog()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onClose).toHaveBeenCalled()
		expect(api.tasks.delete).not.toHaveBeenCalled()
	})
})
