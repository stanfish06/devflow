import type { Task } from '@devflow/db/tables/tasks'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StageId } from '@/lib/kanban/columnEngine'
import type { TaskRow } from '@/minimalist/lib/data'
import { toDraftLaunch } from '@/minimalist/lib/launch-form'

import { BoardPage, StageTag } from './BoardPage'

const { navigate, run, hosts, tree } = vi.hoisted(() => ({
	navigate: vi.fn(),
	run: vi.fn(),
	hosts: { hosts: [{ host: { host_id: 'laptop' }, name: 'laptop', online: true }], isReady: true },
	tree: { recent: [] as TaskRow[], isReady: true },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('@/minimalist/lib/data', () => ({
	useTaskTree: () => tree,
	useHosts: () => hosts,
	useProjects: () => ({ data: [] }),
}))
vi.mock('@/minimalist/lib/use-card-action', () => ({ useCardAction: () => run }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast: vi.fn(), closeSidebarOnNarrow: vi.fn() }) }))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: { tasks: { update: vi.fn() } } }) }))

function draft(): TaskRow {
	return {
		task: {
			id: 'draft-id',
			name: 'Retry webhooks',
			is_draft: true,
			status: 'todo',
			resource_owner_user_id: 'owner',
			draft_launch: toDraftLaunch({
				text: 'Retry webhooks',
				target: { kind: 'directory', path: '/tmp' },
				hostId: 'laptop',
				settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'auto' },
				taskSize: 'small',
				smallAutoAdvance: false,
				attachments: [],
			}),
		} as Task,
		sessions: [],
		latest: null,
		attention: 'idle',
		lastActivity: Date.now(),
		projectName: 'app',
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	run.mockResolvedValue(undefined)
	hosts.hosts[0]!.online = true
	tree.recent = [draft()]
})

describe('board card controls', () => {
	it.each(['board', 'list'] as const)(
		'starts from the %s without navigating; opening the name still edits the draft',
		async (layout) => {
			render(<BoardPage layout={layout} onLayout={vi.fn()} />)
			const todo = within(screen.getByRole('region', { name: 'Todo', exact: true }))
			expect(todo.getByText('Draft', { exact: true })).toBeVisible()
			await act(async () => {
				fireEvent.click(todo.getByRole('button', { name: 'Start Retry webhooks' }))
			})
			expect(run).toHaveBeenCalledExactlyOnceWith(tree.recent[0], { kind: 'start' })
			expect(navigate).not.toHaveBeenCalled()
			fireEvent.click(todo.getByText('Retry webhooks', { exact: true }))
			expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/', search: { task: 'draft-id' } })
		},
	)

	it('shows the saved host blocker on Start without dispatching it', () => {
		hosts.hosts[0]!.online = false
		render(<BoardPage layout="board" onLayout={vi.fn()} />)
		const start = screen.getByRole('button', { name: 'Start Retry webhooks' })
		expect(start).toHaveAttribute('aria-disabled', 'true')
		expect(start).toHaveAttribute('title', 'laptop is offline')
		fireEvent.click(start)
		expect(run).not.toHaveBeenCalled()
		expect(navigate).not.toHaveBeenCalled()
	})
})

const LABELS: Record<StageId, string> = {
	'research-design': 'Research & Design',
	planning: 'Planning',
	implementation: 'Implementation',
	'in-review': 'In Review',
}

describe('StageTag', () => {
	it.each(Object.entries(LABELS) as Array<[StageId, string]>)(
		'renders %s as one tagged pill titled %s',
		(stage, label) => {
			const { container } = render(<StageTag stage={stage} />)
			const tags = container.querySelectorAll('[data-stage]')
			expect(tags).toHaveLength(1)
			expect(tags[0]?.getAttribute('data-stage')).toBe(stage)
			expect(tags[0]?.textContent).toBe(label)
		},
	)

	it('renders nothing when the task has no stage', () => {
		const { container } = render(<StageTag stage={null} />)
		expect(container.innerHTML).toBe('')
	})
})
