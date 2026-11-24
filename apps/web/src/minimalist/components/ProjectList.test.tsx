import type { Session } from '@devflow/db/tables/sessions'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectList } from './ProjectList'

type Fixture = {
	name: string
	mine: boolean
	tasks?: number
	/** Null: a clone-on-demand project, or a folder group that never ran. */
	hostIds?: string[] | null
	projectId?: string | null
	/** Where each task's latest session ran. */
	latestHostIds?: Array<string | null>
}

const { route, data, working } = vi.hoisted(() => ({
	route: { selectedTaskId: 'task-7' },
	data: {
		standalone: [] as Session[],
		emptyProjects: [] as Fixture[],
		projectHostIds: null as string[] | null,
	},
	working: { id: 'all' as string, set: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
	useParams: () => ({}),
	useNavigate: () => vi.fn(),
	useLocation: () => ({ pathname: '/tasks/task-7', search: {} }),
	Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}))
vi.mock('@/minimalist/lib/data', () => ({
	useOpenTaskId: () => route.selectedTaskId,
	useHosts: () => ({
		isReady: true,
		hosts: [
			{ host: { host_id: 'mac-studio-id' }, name: 'mac-studio', online: true },
			{ host: { host_id: 'linux-box-id' }, name: 'linux-box', online: true },
		],
	}),
	useTaskTree: () => ({
		isReady: true,
		standalone: data.standalone,
		groups: [
			{
				key: 'project',
				name: 'Project',
				projectId: 'project',
				mine: true,
				hostIds: data.projectHostIds,
				tasks: Array.from({ length: 8 }, (_, index) => ({
					task: { id: `task-${index}`, name: `Task ${index}` },
					latest: null,
					latestHostId: null,
				})),
			},
			...data.emptyProjects.map(
				({ name, mine, tasks = 0, hostIds = null, projectId = name, latestHostIds = [] }) => ({
					key: name,
					name,
					projectId,
					mine,
					hostIds,
					tasks: Array.from({ length: tasks }, (_, index) => ({
						task: { id: `${name}-${index}`, name: `${name} task ${index}` },
						latest: null,
						latestHostId: latestHostIds[index] ?? null,
					})),
				}),
			),
		],
	}),
}))
vi.mock('@/minimalist/lib/use-working-host', () => ({
	useWorkingHost: () => ({ id: working.id, host: null, state: 'online', isReady: true, set: working.set }),
}))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ closeSidebarOnNarrow: vi.fn(), showToast: vi.fn() }) }))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: {} }) }))
vi.mock('./Menu', () => ({ Menu: () => null, MenuItem: () => null }))
vi.mock('./TaskItem', () => ({
	TaskItem: ({
		row,
		selected,
		elsewhere,
	}: {
		row: { task: { name: string } }
		selected: boolean
		elsewhere?: string | null
	}) => (
		<a href="#task" aria-current={selected ? 'page' : undefined} data-elsewhere={elsewhere ?? undefined}>
			{row.task.name}
		</a>
	),
}))

beforeEach(() => {
	localStorage.clear()
	localStorage.setItem('hl-min-collapsed-projects', JSON.stringify(['project']))
	route.selectedTaskId = 'task-7'
	data.standalone = []
	data.emptyProjects = []
	data.projectHostIds = null
	working.id = 'all'
	working.set.mockReset()
})

describe('standalone session names', () => {
	it('shows a generated summary and switches to an explicit name when one is provided', () => {
		data.standalone = [
			{ id: 'session', title: null, summary: 'Standalone summary', last_activity_at: BigInt(Date.now()) },
		] as Session[]
		const view = render(<ProjectList />)
		expect(screen.getByRole('link', { name: /^Standalone summary/ })).toBeInTheDocument()
		data.standalone = [{ ...data.standalone[0]!, title: 'My session name' }]
		view.rerender(<ProjectList />)
		expect(screen.getByRole('link', { name: /^My session name/ })).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /^Standalone summary/ })).toBeNull()
	})
})
afterEach(cleanup)

describe('selected task project disclosure', () => {
	it('reveals a selected task beyond the preview cap, permits collapse, and reveals only when selection changes', () => {
		const view = render(<ProjectList />)
		const disclosure = screen.getByRole('button', { name: 'Project' })
		expect(disclosure).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getByRole('link', { name: 'Task 7' })).toHaveAttribute('aria-current', 'page')
		fireEvent.click(disclosure)
		expect(disclosure).toHaveAttribute('aria-expanded', 'false')
		// A fresh query result must not undo the user's collapse while the selected task stays the same.
		view.rerender(<ProjectList />)
		expect(disclosure).toHaveAttribute('aria-expanded', 'false')
		expect(screen.queryByRole('link', { name: 'Task 7' })).toBeNull()
		route.selectedTaskId = 'task-2'
		view.rerender(<ProjectList />)
		expect(disclosure).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getByRole('link', { name: 'Task 2' })).toHaveAttribute('aria-current', 'page')
	})
})

describe('shared projects', () => {
	it('hides other people’s projects that hold none of your tasks', () => {
		data.emptyProjects = [
			{ name: 'Mine empty', mine: true },
			{ name: 'Shared empty', mine: false },
		]
		render(<ProjectList />)
		expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Mine empty' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Shared empty' })).toBeNull()
	})

	it('shows a shared project in blue while it holds one of your tasks', () => {
		data.emptyProjects = [{ name: 'Shared busy', mine: false, tasks: 1 }]
		render(<ProjectList />)
		const toggle = screen.getByRole('button', { name: 'Shared busy' })
		expect(toggle).toHaveAttribute('title', 'Shared busy\nShared with you')
		expect(toggle.querySelector('.proj-icon')).toHaveClass('shared')
		expect(screen.getByRole('button', { name: 'Project' }).querySelector('.proj-icon')).not.toHaveClass('shared')
	})
})

describe('masking by the working host', () => {
	beforeEach(() => {
		data.emptyProjects = [
			{ name: 'Studio checkout', mine: true, hostIds: ['mac-studio-id'] },
			{ name: 'Clone anywhere', mine: true, hostIds: null },
			{ name: 'Both hosts', mine: true, hostIds: ['linux-box-id', 'mac-studio-id'] },
			{ name: 'studio-folder', mine: true, projectId: null, hostIds: ['mac-studio-id'], tasks: 1 },
			{ name: 'never-ran', mine: true, projectId: null, hostIds: null, tasks: 1 },
		]
	})

	const shown = () => screen.queryAllByRole('button', { expanded: true }).map((button) => button.textContent)

	it('shows every project on All hosts', () => {
		render(<ProjectList />)
		expect(shown()).toEqual([
			'Project',
			'Studio checkout',
			'Clone anywhere',
			'Both hosts',
			'studio-folder',
			'never-ran',
		])
	})

	it('hides projects checked out only on other hosts, and folders that ran only there', () => {
		working.id = 'linux-box-id'
		render(<ProjectList />)
		expect(shown()).toEqual(['Project', 'Clone anywhere', 'Both hosts', 'never-ran'])
	})

	it('brings them back when switching to the host that has them', () => {
		working.id = 'linux-box-id'
		const view = render(<ProjectList />)
		expect(screen.queryByRole('button', { name: 'Studio checkout' })).toBeNull()
		working.id = 'mac-studio-id'
		view.rerender(<ProjectList />)
		expect(screen.getByRole('button', { name: 'Studio checkout' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'studio-folder' })).toBeInTheDocument()
	})

	it('tags a task that last ran on another host with that host’s name, and never hides it', () => {
		data.emptyProjects = [
			{
				name: 'Shared work',
				mine: true,
				hostIds: null,
				tasks: 4,
				latestHostIds: ['linux-box-id', 'mac-studio-id', null, 'teammate-host-123'],
			},
		]
		working.id = 'mac-studio-id'
		render(<ProjectList />)
		const tag = (name: string) => screen.getByRole('link', { name }).getAttribute('data-elsewhere')
		expect(tag('Shared work task 0')).toBe('linux-box')
		expect(tag('Shared work task 1')).toBeNull()
		expect(tag('Shared work task 2')).toBeNull()
		// A host you don't have goes by its short id.
		expect(tag('Shared work task 3')).toBe('teammate')
	})

	it('tags nothing on All hosts', () => {
		data.emptyProjects = [{ name: 'Shared work', mine: true, tasks: 1, latestHostIds: ['linux-box-id'] }]
		render(<ProjectList />)
		expect(screen.getByRole('link', { name: 'Shared work task 0' })).not.toHaveAttribute('data-elsewhere')
	})

	it('offers to show every host when this one has none of your projects', () => {
		data.emptyProjects = [{ name: 'Studio only', mine: true, hostIds: ['mac-studio-id'] }]
		data.projectHostIds = ['mac-studio-id']
		working.id = 'linux-box-id'
		render(<ProjectList />)
		expect(screen.queryByText(/Add a project to start/)).toBeNull()
		expect(screen.getByText(/No projects on this host/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Show all hosts' }))
		expect(working.set).toHaveBeenCalledWith('all')
	})
})
