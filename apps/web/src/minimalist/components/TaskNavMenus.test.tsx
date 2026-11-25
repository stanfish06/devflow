import type { Session } from '@devflow/db/tables/sessions'
import type { Task } from '@devflow/db/tables/tasks'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TaskRow } from '@/minimalist/lib/data'
import { MinimalistPortalContext } from '@/minimalist/lib/portal'

import { TaskItem } from './TaskItem'
import { SessionRowMenu } from './TaskNavMenus'
import { ThreadActions } from './ThreadActions'

// jsdom has no modal dialogs; the menu only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const copy = vi.fn()
const { auth, data } = vi.hoisted(() => ({
	auth: { user: { id: 'me' } as { id: string } | null },
	data: { task: null as Task | null },
}))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => auth }))
vi.mock('@/minimalist/lib/data', () => ({
	useTask: () => ({ task: data.task, sessions: [], isReady: true }),
	useOpenTaskId: () => undefined,
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/tasks/task-1">{children}</a>,
	useNavigate: () => vi.fn(),
}))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: {} }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({
	useUi: () => ({ closeSidebarOnNarrow: vi.fn(), showToast: vi.fn() }),
}))
vi.mock('@/minimalist/lib/use-unread', () => ({
	useTaskUnread: () => false,
	useUnreadActions: () => ({ markRead: vi.fn(), markUnread: vi.fn() }),
}))
vi.mock('@/minimalist/lib/drafts', () => ({ useHasDraft: () => false, newTaskDraftKey: (id: string) => id }))
vi.mock('@/minimalist/lib/auto-advance', () => ({ useTaskAutoAdvance: () => ({ available: false }) }))
vi.mock('@/minimalist/lib/use-delete', () => ({
	useDelete: () => ({ remove: vi.fn(), pending: false, error: null }),
}))
vi.mock('@/minimalist/components/Avatar', () => ({ WiredUserAvatar: () => null }))
vi.mock('@/minimalist/components/PromptAccessDialog', () => ({ PromptAccessDialog: () => null }))
vi.mock('@/minimalist/lib/use-copy', () => ({ useCopy: () => copy }))
vi.mock('@/minimalist/lib/use-archive', () => ({ useArchive: () => ({ pending: false, archive: vi.fn() }) }))
vi.mock('@/minimalist/lib/access', () => ({ useSessionAccess: () => ({ canManageSession: false }) }))
vi.mock('@/hooks/stores/settingsStore', () => ({
	useSettingsStore: (pick: (state: unknown) => unknown) =>
		pick({ orgSettings: { multiplayerPromptingEnabled: false } }),
}))
vi.mock('@/hooks/stores/unreadStore', () => ({
	useUnreadStore: Object.assign((pick: (state: unknown) => unknown) => pick({ unreadSessionIds: new Set() }), {
		getState: () => ({ markRead: vi.fn(), markUnread: vi.fn() }),
	}),
}))

afterEach(() => {
	cleanup()
	copy.mockClear()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const session = { id: 'session-1', archived: false } as unknown as Session

function openMenu() {
	const anchor = createRef<HTMLElement>()
	render(
		<MinimalistPortalContext value={document.body}>
			<SessionRowMenu anchor={anchor} session={session} selected onClose={vi.fn()} onDialog={vi.fn()} />
		</MinimalistPortalContext>,
	)
}

describe('SessionRowMenu', () => {
	// In the desktop app the page's origin is tauri://localhost, which nobody else can open.
	it('copies a web link that can hand off to the desktop app, not the page address', () => {
		vi.stubEnv('VITE_PUBLIC_APP_ORIGIN', 'https://app.devflow.com')
		openMenu()
		fireEvent.click(screen.getByText('Copy link'))
		expect(copy).toHaveBeenCalledWith(
			'https://app.devflow.com/sessions/session-1?deep=true',
			'Session link copied',
			expect.any(String),
		)
	})

	it('opens a new window in this app', () => {
		vi.stubEnv('VITE_PUBLIC_APP_ORIGIN', 'https://app.devflow.com')
		const open = vi.spyOn(window, 'open').mockReturnValue(null)
		openMenu()
		fireEvent.click(screen.getByText('Open in new window'))
		expect(open).toHaveBeenCalledWith(`${window.location.origin}/sessions/session-1`, '_blank', 'noopener')
	})
})

const task = (owner: string) =>
	({ id: 'task-1', name: 'Fix host chip', resource_owner_user_id: owner, archived: false, is_draft: false }) as Task

function renderTaskItem(owner: string) {
	const row = {
		task: task(owner),
		sessions: [],
		latest: null,
		attention: null,
		lastActivity: 0,
		projectName: null,
		latestHostId: null,
	} as unknown as TaskRow
	render(
		<MinimalistPortalContext value={document.body}>
			<TaskItem row={row} selected={false} />
		</MinimalistPortalContext>,
	)
	fireEvent.click(screen.getByRole('button', { name: 'More for Fix host chip' }))
}

function renderThreadActions(owner: string) {
	data.task = task(owner)
	render(
		<MinimalistPortalContext value={document.body}>
			<ThreadActions session={{ ...session, task_id: 'task-1' } as Session} />
		</MinimalistPortalContext>,
	)
	fireEvent.click(screen.getByRole('button', { name: 'Task and session actions' }))
}

const menuLabels = () => Array.from(document.querySelectorAll('dialog.pop .mi')).map((item) => item.textContent?.trim())

describe.each([
	['the sidebar task menu', renderTaskItem],
	["the task header's actions menu", renderThreadActions],
])('Delete task… in %s', (_where, renderMenu) => {
	it('is the last, destructive item for the task owner', () => {
		renderMenu('me')
		expect(menuLabels().at(-1)).toBe('Delete task…')
		const item = screen.getByRole('button', { name: 'Delete task…' })
		expect(item.className).toContain('danger')
		expect(item.previousElementSibling?.className).toBe('sep')
	})

	it('opens the confirmation instead of deleting', () => {
		renderMenu('me')
		fireEvent.click(screen.getByRole('button', { name: 'Delete task…' }))
		expect(screen.getByRole('heading', { name: 'Delete “Fix host chip”?' })).toBeTruthy()
	})

	it("isn't offered on a teammate's task", () => {
		renderMenu('teammate')
		expect(menuLabels()).not.toContain('Delete task…')
	})
})
