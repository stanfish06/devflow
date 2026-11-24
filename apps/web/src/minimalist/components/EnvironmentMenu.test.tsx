import type { Session } from '@devflow/db/tables/sessions'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostView } from '@/minimalist/lib/data'
import type { GithubAccount, GithubAccountPick } from '@/minimalist/lib/github-accounts'
import { MinimalistPortalContext } from '@/minimalist/lib/portal'

import { EnvironmentMenu } from './EnvironmentMenu'

// jsdom has no modal dialogs; the menu only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { state, setGithubAccount, showToast } = vi.hoisted(() => ({
	state: {
		accounts: [] as GithubAccount[],
		defaultAccountId: null as string | null,
		projectDefaults: {} as Record<string, string>,
		taskPick: undefined as GithubAccountPick | undefined,
	},
	setGithubAccount: vi.fn(),
	showToast: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: { tasks: { setGithubAccount } } }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))
vi.mock('@/minimalist/lib/use-copy', () => ({ useCopy: () => vi.fn() }))
vi.mock('@/minimalist/lib/data', () => ({
	useTask: () => ({ task: { id: 'task', project_id: 'project' }, sessions: [], isReady: true }),
	useHosts: () => ({ hosts: [], isReady: true }),
	taskBranch: () => 'task-branch',
}))
// The real resolution over fake accounts and a fake synced pick for the task.
vi.mock('@/minimalist/lib/github-accounts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/minimalist/lib/github-accounts')>()
	const accounts = () => ({ ...state, isReady: true, isError: false })
	return {
		...actual,
		useGithubAccounts: accounts,
		useResolvedGithubAccount: ({ projectId }: { projectId?: string | null }) => ({
			...actual.resolveGithubAccount({
				accounts: state.accounts,
				task: state.taskPick,
				project: projectId ? state.projectDefaults[projectId] : undefined,
				defaultAccountId: state.defaultAccountId,
			}),
			accounts: state.accounts,
			isReady: true,
		}),
	}
})

const account = (id: string, login: string): GithubAccount => ({
	id,
	login,
	name: null,
	noreplyEmail: `1+${login}@users.noreply.github.com`,
	status: 'ok',
	createdAt: 0,
})

const host = { host: { host_id: 'mac', distribution: 'app' }, name: 'mac-studio', online: true } as unknown as HostView

function renderChip(createdBy = 'me') {
	const session = {
		id: 'session',
		task_id: 'task',
		created_by: createdBy,
		working_directory: '/code/app',
	} as unknown as Session
	render(
		<MinimalistPortalContext value={document.body}>
			<EnvironmentMenu session={session} host={host} />
		</MinimalistPortalContext>,
	)
}

beforeEach(() => {
	state.accounts = [account('work', 'stan-work'), account('personal', 'stan-personal')]
	state.defaultAccountId = 'personal'
	state.projectDefaults = { project: 'work' }
	state.taskPick = undefined
	setGithubAccount.mockResolvedValue({})
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('EnvironmentMenu GitHub account', () => {
	it('shows the account your session pushes as beside the host and branch', () => {
		renderChip()
		const chip = screen.getByRole('button', { name: /^Environment: mac-studio/ })
		expect(chip).toHaveAccessibleName('Environment: mac-studio, online, pushes as stan-work')
		expect(chip).toHaveTextContent('mac-studio·task-branch·stan-work')
	})

	it("leaves a teammate's session alone: their account follows their own choices", () => {
		renderChip('teammate')
		expect(screen.getByRole('button', { name: 'Environment: mac-studio, online' })).not.toHaveTextContent(
			'stan-work',
		)
	})

	it('shows nothing about accounts when you have none', () => {
		state.accounts = []
		state.defaultAccountId = null
		state.projectDefaults = {}
		renderChip()
		expect(screen.getByRole('button', { name: 'Environment: mac-studio, online' })).toBeInTheDocument()
	})

	it('changes the task’s account from the same menu as the composer', async () => {
		renderChip()
		fireEvent.click(screen.getByRole('button', { name: /^Environment/ }))
		const current = screen.getByRole('button', { name: /^stan-work/ })
		expect(current).toHaveTextContent("The project's default · Change…")
		fireEvent.click(current)
		fireEvent.click(screen.getByRole('button', { name: /^stan-personal/ }))
		await waitFor(() =>
			expect(setGithubAccount).toHaveBeenCalledWith(
				{ taskId: 'task', accountId: 'personal' },
				{ context: { silent: true } },
			),
		)
		await waitFor(() => expect(showToast).toHaveBeenCalledWith('This task now pushes as stan-personal'))
	})

	it("pins the host's own gh login for the task", async () => {
		renderChip()
		fireEvent.click(screen.getByRole('button', { name: /^Environment/ }))
		fireEvent.click(screen.getByRole('button', { name: /^stan-work/ }))
		fireEvent.click(screen.getByRole('button', { name: /^Host's own gh login/ }))
		await waitFor(() =>
			expect(setGithubAccount).toHaveBeenCalledWith({ taskId: 'task', accountId: null }, expect.anything()),
		)
	})

	it('shows a pick made for the task, and skips re-picking it', () => {
		state.taskPick = null
		renderChip()
		expect(screen.getByRole('button', { name: /^Environment/ })).toHaveTextContent('Host gh login')
		fireEvent.click(screen.getByRole('button', { name: /^Environment/ }))
		const current = screen.getByRole('button', { name: /^Host gh login/ })
		expect(current).toHaveTextContent('Picked for this task')
		fireEvent.click(current)
		fireEvent.click(screen.getByRole('button', { name: /^Host's own gh login/ }))
		expect(setGithubAccount).not.toHaveBeenCalled()
	})
})
