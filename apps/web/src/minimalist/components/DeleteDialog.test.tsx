import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DeleteDialog } from './DeleteDialog'

// jsdom has no modal dialogs; the dialog only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { api, queries, navigate, showToast, open } = vi.hoisted(() => {
	const api = {
		tasks: { delete: vi.fn(), deleteArchived: vi.fn(), deleteArchivedPreview: vi.fn() },
		projects: { v2: { delete: vi.fn(), deletePreview: vi.fn() } },
	}
	// The oRPC query helpers, down to the previews the dialogs read.
	const queries = {
		tasks: {
			deleteArchivedPreview: {
				queryOptions: () => ({
					queryKey: ['tasks', 'deleteArchivedPreview'],
					queryFn: () => api.tasks.deleteArchivedPreview({}),
				}),
			},
		},
		projects: {
			v2: {
				deletePreview: {
					key: () => ['projects', 'v2', 'deletePreview'],
					queryOptions: ({ input }: { input: { projectId: string } }) => ({
						queryKey: ['projects', 'v2', 'deletePreview', input.projectId],
						queryFn: () => api.projects.v2.deletePreview(input),
					}),
				},
			},
		},
	}
	return {
		api,
		queries,
		navigate: vi.fn(),
		showToast: vi.fn(),
		open: { taskId: undefined as string | undefined },
	}
})

vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: api, queryClient: queries }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/minimalist/lib/data', () => ({ useOpenTaskId: () => open.taskId }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))

const target = { kind: 'task', taskId: 'task-1', title: 'Fix host chip' } as const

let queryClient: QueryClient

function renderWithQueries(element: ReactElement) {
	return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
}

function renderDialog() {
	const onClose = vi.fn()
	renderWithQueries(<DeleteDialog target={target} onClose={onClose} />)
	return { onClose }
}

const pressCommandEnter = () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', metaKey: true })

beforeEach(() => {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	api.tasks.delete.mockResolvedValue({ taskId: 'task-1' })
	api.projects.v2.deletePreview.mockResolvedValue({ taskCount: 12, otherPeoplesTaskCount: 3 })
	api.projects.v2.delete.mockResolvedValue({ deletedTaskCount: 12 })
	api.tasks.deleteArchivedPreview.mockResolvedValue({ deletableCount: 2, skippedSharedCount: 1 })
	api.tasks.deleteArchived.mockResolvedValue({ deletedCount: 2 })
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

describe('DeleteDialog for a project', () => {
	const project = { kind: 'project', projectId: 'project-1', name: 'infra-scripts' } as const

	function renderProjectDialog() {
		const onClose = vi.fn()
		renderWithQueries(<DeleteDialog target={project} onClose={onClose} />)
		return { onClose }
	}

	const deleteButton = () => screen.getByRole('button', { name: 'Delete project' }) as HTMLButtonElement
	const typeName = (value: string) =>
		fireEvent.change(screen.getByLabelText('Type to confirm'), { target: { value } })
	const counted = (text: string) =>
		screen.findByText((_, element) => element?.tagName === 'P' && element.textContent?.includes(text) === true)

	it('counts the tasks it takes on the server, teammates’ included, and says what stays', async () => {
		renderProjectDialog()
		expect(screen.getByRole('heading', { name: 'Delete “infra-scripts”?' })).toBeTruthy()
		expect(await counted('This also deletes 12 tasks (3 by others)')).toBeTruthy()
		expect(api.projects.v2.deletePreview).toHaveBeenCalledWith({ projectId: 'project-1' })
		expect(
			screen.getByText('Checkouts, worktrees and branches on your hosts are kept. Nothing on GitHub changes.'),
		).toBeTruthy()
		expect(screen.getByLabelText('Type to confirm').getAttribute('placeholder')).toBe('infra-scripts')
	})

	it('stays inert, ⌘↵ included, until the name is typed exactly', async () => {
		const { onClose } = renderProjectDialog()
		await counted('12 tasks')
		expect(deleteButton().disabled).toBe(true)
		pressCommandEnter()
		typeName('infra-scr')
		expect(deleteButton().disabled).toBe(true)
		pressCommandEnter()
		typeName('Infra-Scripts')
		expect(deleteButton().disabled).toBe(true)
		pressCommandEnter()
		expect(api.projects.v2.delete).not.toHaveBeenCalled()

		typeName('infra-scripts')
		expect(deleteButton().disabled).toBe(false)
		const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
		pressCommandEnter()
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(api.projects.v2.delete).toHaveBeenCalledWith(
			{ projectId: 'project-1', expectedTaskCount: 12 },
			{ context: { silent: true } },
		)
		expect(showToast).toHaveBeenCalledWith('infra-scripts deleted')
		// Projects aren't synced: the lists refetch so the sidebar drops it.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'v2'] })
	})

	it('counts again when the server finds a different number, and deletes nothing until reconfirmed', async () => {
		api.projects.v2.delete.mockRejectedValueOnce(
			new ORPCError('COUNT_CHANGED', { defined: true, status: 409, data: { expected: 12, actual: 13 } }),
		)
		const { onClose } = renderProjectDialog()
		await counted('12 tasks')
		api.projects.v2.deletePreview.mockResolvedValue({ taskCount: 13, otherPeoplesTaskCount: 4 })
		typeName('infra-scripts')
		pressCommandEnter()

		expect(await counted('This also deletes 13 tasks (4 by others)')).toBeTruthy()
		expect(screen.getByRole('alert').textContent).toBe(
			'Its tasks changed since this opened. Check the new count, then delete again.',
		)
		expect(api.projects.v2.deletePreview).toHaveBeenCalledTimes(2)
		expect(onClose).not.toHaveBeenCalled()
		expect(showToast).not.toHaveBeenCalled()

		fireEvent.click(deleteButton())
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(api.projects.v2.delete).toHaveBeenLastCalledWith(
			{ projectId: 'project-1', expectedTaskCount: 13 },
			{ context: { silent: true } },
		)
	})

	it('says so when the project has no tasks', async () => {
		api.projects.v2.deletePreview.mockResolvedValue({ taskCount: 0, otherPeoplesTaskCount: 0 })
		renderProjectDialog()
		expect(await counted('It has no tasks.')).toBeTruthy()
	})

	it('shows a failed count inside the dialog and never offers Delete', async () => {
		api.projects.v2.deletePreview.mockRejectedValue(new Error('FORBIDDEN'))
		renderProjectDialog()
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe("Could not count infra-scripts's tasks. Try again."),
		)
		typeName('infra-scripts')
		expect(deleteButton().disabled).toBe(true)
	})

	it('shows a failed delete inside the dialog and stays open', async () => {
		api.projects.v2.delete.mockRejectedValue(new Error('FORBIDDEN'))
		const { onClose } = renderProjectDialog()
		await counted('12 tasks')
		typeName('infra-scripts')
		pressCommandEnter()
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe('Could not delete infra-scripts. Try again.'),
		)
		expect(onClose).not.toHaveBeenCalled()
		expect(api.projects.v2.deletePreview).toHaveBeenCalledTimes(1)
	})
})

describe('DeleteDialog for all archived tasks', () => {
	function renderArchivedDialog() {
		const onClose = vi.fn()
		renderWithQueries(<DeleteDialog target={{ kind: 'archived-tasks' }} onClose={onClose} />)
		return { onClose }
	}

	const deleteButton = (label = 'Delete 2 tasks') => screen.getByRole('button', { name: label }) as HTMLButtonElement
	const typePhrase = (value: string) =>
		fireEvent.change(screen.getByLabelText('Type to confirm'), { target: { value } })
	const counted = (text: string) =>
		screen.findByText((_, element) => element?.tagName === 'P' && element.textContent?.includes(text) === true)

	it('states the server’s exact count and the shared tasks it skips', async () => {
		renderArchivedDialog()
		expect(await screen.findByRole('heading', { name: 'Delete 2 archived tasks?' })).toBeTruthy()
		expect(await counted('every archived task you own, 2 tasks')).toBeTruthy()
		expect(await counted('1 archived task shared with you is skipped.')).toBeTruthy()
		expect(
			screen.getByText('Worktrees and branches on your hosts are kept. Nothing on GitHub changes.'),
		).toBeTruthy()
		expect(screen.getByLabelText('Type to confirm').getAttribute('placeholder')).toBe('delete 2 tasks')
	})

	it('stays inert, ⌘↵ included, until `delete N tasks` is typed for that count', async () => {
		const { onClose } = renderArchivedDialog()
		await counted('2 tasks')
		expect(deleteButton().disabled).toBe(true)
		pressCommandEnter()
		typePhrase('delete 2')
		expect(deleteButton().disabled).toBe(true)
		typePhrase('delete 3 tasks')
		expect(deleteButton().disabled).toBe(true)
		pressCommandEnter()
		expect(api.tasks.deleteArchived).not.toHaveBeenCalled()

		typePhrase('delete 2 tasks')
		expect(deleteButton().disabled).toBe(false)
		const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
		pressCommandEnter()
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(api.tasks.deleteArchived).toHaveBeenCalledWith({ expectedCount: 2 }, { context: { silent: true } })
		expect(showToast).toHaveBeenCalledWith('Deleted 2 tasks')
		// Archived projects' task counts included the deleted tasks.
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'v2', 'deletePreview'] })
	})

	it('counts again when the server finds a different number, and needs the new phrase', async () => {
		api.tasks.deleteArchived.mockRejectedValueOnce(
			new ORPCError('COUNT_CHANGED', { defined: true, status: 409, data: { expected: 2, actual: 3 } }),
		)
		const { onClose } = renderArchivedDialog()
		await counted('2 tasks')
		api.tasks.deleteArchivedPreview.mockResolvedValue({ deletableCount: 3, skippedSharedCount: 0 })
		typePhrase('delete 2 tasks')
		pressCommandEnter()

		expect(await counted('every archived task you own, 3 tasks')).toBeTruthy()
		expect(screen.getByRole('alert').textContent).toBe(
			'Your archived tasks changed since this opened. Check the new count, then delete again.',
		)
		expect(onClose).not.toHaveBeenCalled()
		// The old phrase no longer confirms the new count.
		expect(deleteButton('Delete 3 tasks').disabled).toBe(true)
		typePhrase('delete 3 tasks')
		fireEvent.click(deleteButton('Delete 3 tasks'))
		await waitFor(() => expect(onClose).toHaveBeenCalled())
		expect(api.tasks.deleteArchived).toHaveBeenLastCalledWith({ expectedCount: 3 }, { context: { silent: true } })
	})

	it('says "1 task" for a single task', async () => {
		api.tasks.deleteArchivedPreview.mockResolvedValue({ deletableCount: 1, skippedSharedCount: 2 })
		renderArchivedDialog()
		expect(await screen.findByRole('heading', { name: 'Delete 1 archived task?' })).toBeTruthy()
		expect(await counted('2 archived tasks shared with you are skipped.')).toBeTruthy()
		expect(screen.getByLabelText('Type to confirm').getAttribute('placeholder')).toBe('delete 1 task')
	})

	it('offers nothing to delete when you own no archived tasks', async () => {
		api.tasks.deleteArchivedPreview.mockResolvedValue({ deletableCount: 0, skippedSharedCount: 1 })
		renderArchivedDialog()
		expect(await counted('You have no archived tasks of your own to delete.')).toBeTruthy()
		expect(screen.queryByLabelText('Type to confirm')).toBeNull()
		expect(deleteButton('Delete tasks').disabled).toBe(true)
	})

	it('shows a failed count inside the dialog and never offers Delete', async () => {
		api.tasks.deleteArchivedPreview.mockRejectedValue(new Error('UNAVAILABLE'))
		renderArchivedDialog()
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toBe('Could not count your archived tasks. Try again.'),
		)
		expect(deleteButton('Delete tasks').disabled).toBe(true)
	})
})
