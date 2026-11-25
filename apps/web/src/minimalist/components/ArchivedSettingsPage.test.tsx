import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeleteTarget } from '@/minimalist/lib/use-delete'

import { ArchivedSettingsPage } from './SettingsPages'

const { api, queries, showToast, tree } = vi.hoisted(() => {
	const api = {
		tasks: { archive: vi.fn() },
		sessions: { update: vi.fn() },
		projects: { v2: { list: vi.fn(), archive: vi.fn(), deletePreview: vi.fn() } },
	}
	// The oRPC query helpers the page reads: the project lists and each project's delete count.
	const queries = {
		projects: {
			v2: {
				list: {
					queryOptions: ({ input }: { input: { archived: boolean } }) => ({
						queryKey: ['projects', 'v2', 'list', input.archived],
						queryFn: () => api.projects.v2.list(input),
					}),
				},
				deletePreview: {
					queryOptions: ({ input }: { input: { projectId: string } }) => ({
						queryKey: ['projects', 'v2', 'deletePreview', input.projectId],
						queryFn: () => api.projects.v2.deletePreview(input),
					}),
				},
			},
		},
	}
	// The archived task tree the page lists, as `useTaskTree(true)` groups it.
	const tree = { groups: [] as Array<{ name: string; tasks: Array<Record<string, unknown>> }> }
	return { api, queries, showToast: vi.fn(), tree }
})

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
	useNavigate: () => vi.fn(),
}))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: api, queryClient: queries }) }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('@/hooks/live-queries/useArchivedSessions', () => ({ useArchivedSessions: () => [] }))
vi.mock('@/minimalist/lib/data', () => ({
	useTaskTree: () => ({ groups: tree.groups, standalone: [], isReady: true }),
	useOpenTaskId: () => undefined,
}))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))
vi.mock('@/minimalist/components/DeleteDialog', () => ({
	DeleteDialog: ({ target }: { target: DeleteTarget }) => {
		switch (target.kind) {
			case 'project':
				return <div role="dialog" aria-label={`Delete ${target.name}`} data-project={target.projectId} />
			case 'task':
				return <div role="dialog" aria-label={`Delete ${target.title}`} data-task={target.taskId} />
			case 'archived-tasks':
				return <div role="dialog" aria-label="Delete all archived tasks" />
		}
	},
}))

const archivedProject = (id: string, name: string, owner: string) => ({
	id,
	organizationId: 'org',
	name,
	description: null,
	private: false,
	createdBy: owner,
	resourceOwnerUserId: owner,
	repositories: [],
	archived: true,
	createdAt: Date.now() - 86_400_000,
	updatedAt: Date.now() - 3 * 86_400_000,
	checkoutHostIds: [],
})

let queryClient: QueryClient

function renderPage() {
	return render(
		<QueryClientProvider client={queryClient}>
			<ArchivedSettingsPage />
		</QueryClientProvider>,
	)
}

beforeEach(() => {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	api.projects.v2.list.mockResolvedValue({
		projects: [
			archivedProject('old-id', 'old-prototype', 'me'),
			archivedProject('theirs-id', 'their-project', 'teammate'),
		],
	})
	api.projects.v2.deletePreview.mockResolvedValue({ taskCount: 4, otherPeoplesTaskCount: 1 })
	api.projects.v2.archive.mockResolvedValue({})
	tree.groups = []
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('archived projects', () => {
	it('lists your own archived projects with the server’s task count', async () => {
		renderPage()
		expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
		expect(screen.getByText('old-prototype')).toBeTruthy()
		expect(await screen.findByText('4 tasks · 3d ago')).toBeTruthy()
		// Only the owner can unarchive or delete it, so a teammate's archived project isn't listed.
		expect(screen.queryByText('their-project')).toBeNull()
		expect(api.projects.v2.list).toHaveBeenCalledWith({ archived: true })
		expect(api.projects.v2.deletePreview).toHaveBeenCalledTimes(1)
	})

	it('unarchives a project and refreshes the project lists', async () => {
		renderPage()
		const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
		fireEvent.click(await screen.findByRole('button', { name: 'Unarchive' }))
		await waitFor(() => expect(showToast).toHaveBeenCalledWith('old-prototype unarchived'))
		expect(api.projects.v2.archive).toHaveBeenCalledWith({ projectId: 'old-id', archived: false })
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'v2'] })
	})

	it('opens the project’s delete confirmation from Delete…', async () => {
		renderPage()
		fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
		expect(screen.getByRole('dialog', { name: 'Delete old-prototype' })).toHaveAttribute('data-project', 'old-id')
	})

	it('says what the page is for when nothing is archived', async () => {
		api.projects.v2.list.mockResolvedValue({ projects: [] })
		renderPage()
		expect(await screen.findByText(/Archived projects, tasks and sessions show up here/)).toBeTruthy()
	})
})

describe('archived tasks', () => {
	const archivedTask = (id: string, name: string, owner: string, daysAgo: number) => ({
		task: { id, name, resource_owner_user_id: owner },
		lastActivity: Date.now() - daysAgo * 86_400_000,
	})

	beforeEach(() => {
		api.projects.v2.list.mockResolvedValue({ projects: [] })
		tree.groups = [
			{
				name: 'devflow',
				tasks: [
					archivedTask('mine-1', 'Try websocket transport', 'me', 2),
					archivedTask('theirs-1', 'Teammate’s spike', 'teammate', 14),
				],
			},
			{ name: 'infra-scripts', tasks: [archivedTask('mine-2', 'Scratch: test PR flow', 'me', 7)] },
		]
	})

	const rowOf = (name: string) => {
		const row = screen.getByText(name).closest('.srow')
		if (!(row instanceof HTMLElement)) throw new Error(`No row for ${name}`)
		return row
	}

	it('offers Delete… only on archived tasks you own, and marks the shared ones', async () => {
		renderPage()
		expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeTruthy()
		expect(within(rowOf('Try websocket transport')).getByRole('button', { name: 'Delete…' })).toBeTruthy()
		expect(within(rowOf('Scratch: test PR flow')).getByRole('button', { name: 'Delete…' })).toBeTruthy()
		const shared = rowOf('Teammate’s spike')
		expect(within(shared).queryByRole('button', { name: 'Delete…' })).toBeNull()
		expect(within(shared).getByRole('button', { name: 'Unarchive' })).toBeTruthy()
		expect(within(shared).getByText('devflow · shared with you · 2w ago')).toBeTruthy()
	})

	it('opens the task’s delete confirmation from its Delete…', async () => {
		renderPage()
		await screen.findByRole('heading', { name: 'Tasks' })
		fireEvent.click(within(rowOf('Scratch: test PR flow')).getByRole('button', { name: 'Delete…' }))
		expect(screen.getByRole('dialog', { name: 'Delete Scratch: test PR flow' })).toHaveAttribute(
			'data-task',
			'mine-2',
		)
	})

	it('opens the bulk confirmation from the Tasks header', async () => {
		renderPage()
		fireEvent.click(await screen.findByRole('button', { name: 'Delete all archived tasks…' }))
		expect(screen.getByRole('dialog', { name: 'Delete all archived tasks' })).toBeTruthy()
	})

	it('has no bulk delete when every archived task listed is shared', async () => {
		tree.groups = [{ name: 'devflow', tasks: [archivedTask('theirs-1', 'Teammate’s spike', 'teammate', 14)] }]
		renderPage()
		expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Delete all archived tasks…' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull()
	})
})
