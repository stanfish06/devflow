import type { Session } from '@devflow/db/tables/sessions'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostView } from '@/minimalist/lib/data'

import { SessionNotice } from './SessionNotice'

const { navigate, pick, account } = vi.hoisted(() => ({
	navigate: vi.fn(),
	pick: vi.fn(),
	account: { shown: true },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('@/minimalist/lib/use-copy', () => ({ useCopy: () => vi.fn() }))
vi.mock('@/minimalist/lib/access', () => ({ useMemberName: () => () => 'Ada' }))
vi.mock('@/minimalist/lib/data', () => ({
	DAEMON_START_COMMAND: 'devflow up',
	useTask: () => ({ task: { id: 'task', project_id: 'project' } }),
	useHosts: () => ({ hosts: [] }),
}))
vi.mock('@/minimalist/lib/use-task-github-account', () => ({
	useTaskGithubAccount: () => ({
		shown: account.shown,
		pending: false,
		projectDefaultId: undefined,
		resolved: { account: 'host', source: 'host', accounts: [], isReady: true },
		pick,
	}),
}))
// The real menu is covered by its own tests; here it only has to open and report a pick.
vi.mock('@/minimalist/components/GithubAccountMenu', () => ({
	GithubAccountMenu: ({ open, onPick }: { open: boolean; onPick: (pick: string | null) => void }) =>
		open ? (
			<button type="button" onClick={() => onPick('personal')}>
				stan-personal
			</button>
		) : null,
}))

const host = { host: { host_id: 'mac' }, name: 'mac-studio', online: true } as unknown as HostView

function renderNotice(fields: Partial<Session>) {
	const session = {
		id: 'session',
		task_id: 'task',
		created_by: 'me',
		status: 'failed',
		coding_agent: 'claude',
		error_message: 'stan-work',
		error_reason: 'github_token_rejected',
		...fields,
	} as unknown as Session
	render(<SessionNotice session={session} host={host} taskId={session.task_id} />)
}

beforeEach(() => {
	account.shown = true
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('SessionNotice for a GitHub account the agent could not use', () => {
	it('names the rejected account and opens GitHub accounts in Settings to replace its token', () => {
		renderNotice({})
		expect(screen.getByText("GitHub rejected stan-work's token")).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Replace token' }))
		expect(navigate).toHaveBeenCalledWith({ to: '/settings/github-accounts' })
	})

	it("switches the task's account from the notice", () => {
		renderNotice({})
		fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
		fireEvent.click(screen.getByRole('button', { name: 'stan-personal' }))
		expect(pick).toHaveBeenCalledWith('personal')
	})

	it('offers only a switch when the account has no access to the repository', () => {
		renderNotice({ error_reason: 'github_no_repo_access' })
		expect(screen.getByText("stan-work can't push to this repository")).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Replace token' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Switch account' })).toBeInTheDocument()
	})

	it("explains a teammate's stopped session without offering to change their account", () => {
		renderNotice({ created_by: 'teammate' })
		expect(screen.getByText("GitHub rejected stan-work's token")).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Replace token' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Switch account' })).not.toBeInTheDocument()
	})

	it('still offers a new token when the session has no task to switch', () => {
		account.shown = false
		renderNotice({ task_id: null })
		expect(screen.getByRole('button', { name: 'Replace token' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Switch account' })).not.toBeInTheDocument()
	})
})
