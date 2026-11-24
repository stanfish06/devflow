import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/hooks/stores/settingsStore'

import { NewTask } from './NewTask'

const {
	useHosts,
	useProjects,
	useTask,
	useRecentDirectories,
	useSlashCommands,
	launchInTask,
	startTask,
	navigate,
	saveDraft,
	confirmTasks,
} = vi.hoisted(() => ({
	startTask: vi.fn(),
	useHosts: vi.fn(),
	useProjects: vi.fn(),
	useTask: vi.fn(),
	useRecentDirectories: vi.fn(),
	useSlashCommands: vi.fn(),
	launchInTask: vi.fn(),
	navigate: vi.fn(),
	saveDraft: vi.fn(),
	confirmTasks: vi.fn(),
}))

function hostView(id: string, online = true) {
	return { host: { host_id: id, supported_models: null }, name: id, online }
}

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/components/providers/SyncProvider', () => ({
	useSyncInternal: () => ({ confirmTx: { tasks: confirmTasks } }),
}))
vi.mock('@/orpc/client', () => ({
	useApi: () => ({
		client: { tasks: { saveDraft } },
		queryClient: {
			projectWorkspaces: { getStatus: { queryOptions: () => ({}) } },
			projects: { v2: { repositorySources: { get: { queryOptions: () => ({}) } } } },
		},
	}),
}))
vi.mock('@/minimalist/lib/launch', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/minimalist/lib/launch')>()),
	launchInTask,
	startTask,
}))
vi.mock('@/minimalist/lib/data', () => ({
	useProjects,
	useTask,
	useRecentDirectories,
	useHosts,
	useTaskTree: () => ({ recent: [] }),
	useSlashCommands,
}))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast: vi.fn() }) }))
vi.mock('@/minimalist/lib/use-attachments', () => ({ useAttachments: () => ({ metadata: [], blocked: false }) }))
vi.mock('@/minimalist/components/Composer', () => ({
	Composer: ({
		value,
		onChange,
		children,
		onSubmit,
		onSaveDraft,
		submitDisabled,
		submitLabel,
		placeholder,
	}: {
		value: string
		onChange: (value: string) => void
		children: ReactNode
		onSubmit: () => void
		onSaveDraft?: () => void
		submitDisabled: boolean
		submitLabel: string
		placeholder: string
	}) => (
		<div>
			{children}
			<textarea
				aria-label="Task instructions"
				placeholder={placeholder}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<button type="button" disabled={submitDisabled} onClick={onSubmit}>
				{submitLabel}
			</button>
			{onSaveDraft ? (
				<button type="button" onClick={onSaveDraft}>
					Save as draft
				</button>
			) : null}
		</div>
	),
}))
// The directory menu is the real one, so a session in a moved directory task picks from it.
vi.mock('@/minimalist/components/LaunchMenus', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/minimalist/components/LaunchMenus')>()),
	HostIcon: () => null,
	HostMenu: ({ onPick }: { onPick: (hostId: string) => void }) => (
		<>
			<button type="button" onClick={() => onPick('host')}>
				Pick host
			</button>
			<button type="button" onClick={() => onPick('mac')}>
				Pick mac
			</button>
			<button type="button" onClick={() => onPick('vm')}>
				Pick vm
			</button>
		</>
	),
	TargetMenu: ({
		open,
		onPick,
	}: {
		open: boolean
		onPick: (target: { kind: 'directory'; path: string }) => void
	}) => (
		<>
			{open ? <div>Project picker</div> : null}
			<button type="button" onClick={() => onPick({ kind: 'directory', path: '/Users/me/repos/self' })}>
				Pick directory
			</button>
		</>
	),
}))
vi.mock('@/minimalist/components/Menu', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/minimalist/components/Menu')>()),
	Menu: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}))
vi.mock('@/minimalist/components/IssueDialog', () => ({ IssueDialog: () => null }))

beforeEach(() => {
	vi.clearAllMocks()
	localStorage.clear()
	launchInTask.mockResolvedValue(undefined)
	startTask.mockResolvedValue(undefined)
	saveDraft.mockImplementation(async (input: { id: string }) => ({
		result: 'saved',
		transactionId: '42',
		task: { id: input.id },
	}))
	confirmTasks.mockResolvedValue(undefined)
	useHosts.mockReturnValue({ hosts: [hostView('host')], isReady: true })
	useProjects.mockReturnValue({ data: [{ id: 'project', name: 'devflow', repositories: [] }], isPending: false })
	useTask.mockReturnValue({ task: null, sessions: [], isReady: true })
	useRecentDirectories.mockReturnValue([])
	useSlashCommands.mockReturnValue([])
})

function expectPlainLanding(container: HTMLElement, heading: string) {
	expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading)
	expect(container.querySelector('.hero')?.children).toHaveLength(1)
	expect(container.querySelector('.hero svg')).toBeNull()
	expect(container.querySelector('.cards')).toBeNull()
	expect(screen.getByRole('textbox', { name: 'Task instructions' })).toBeInTheDocument()
}

vi.mock('@/minimalist/components/WiredTaskNavigation', () => ({ WiredTaskNavigation: () => null }))

describe('minimalist launch landing', () => {
	it('shows only the greeting above the input for a new task and keeps the project picker', () => {
		const { container } = render(<NewTask projectId="project" />)
		expectPlainLanding(container, 'What should we work on in devflow?')
		fireEvent.click(within(screen.getByRole('heading')).getByRole('button', { name: 'devflow' }))
		expect(screen.getByText('Project picker')).toBeInTheDocument()
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix the model picker' } })
		expect(screen.getByRole('textbox')).toHaveValue('Fix the model picker')
	})

	it('names the task when starting a new session', () => {
		useTask.mockReturnValue({
			task: { id: 'task', name: 'Fix tab shortcuts', project_id: 'project', workspace_id: 'workspace' },
			sessions: [{ id: 'session', host_id: 'host', working_directory: '/code/checkout' }],
			isReady: true,
		})
		const { container } = render(<NewTask existingTaskId="task" />)
		expectPlainLanding(container, 'New session in Fix tab shortcuts')
		expect(useSlashCommands).toHaveBeenLastCalledWith({
			hostId: 'host',
			workspacePath: '/code/checkout',
			agent: 'claude',
		})
		expect(screen.queryByRole('button', { name: 'devflow' })).not.toBeInTheDocument()
	})

	it('uses the directory name for a directory task', () => {
		const { container } = render(<NewTask directory="/code/my-app" />)
		expectPlainLanding(container, 'What should we work on in my-app?')
	})

	it('uses the session directory when the task has no project', () => {
		useTask.mockReturnValue({
			task: { id: 'task', name: 'Fix tab shortcuts', project_id: null, workspace_id: null },
			sessions: [{ id: 'session', host_id: 'host', working_directory: '/code/my-app' }],
			isReady: true,
		})
		const { container } = render(<NewTask existingTaskId="task" />)
		expectPlainLanding(container, 'New session in Fix tab shortcuts')
	})

	it('keeps a plain greeting when no project or directory is selected', () => {
		useProjects.mockReturnValue({ data: [], isPending: false })
		const { container } = render(<NewTask />)
		expectPlainLanding(container, 'What should we work on?')
	})
})

describe('minimalist launch autocomplete context', () => {
	it('does not discover the previous host directory when a project task moves to another host', () => {
		useTask.mockReturnValue({
			task: { id: 'task', name: 'Move the project', workspace_id: 'workspace', project_id: 'project' },
			sessions: [{ id: 'session', host_id: 'old-host', working_directory: '/old-host/workspace' }],
			isReady: true,
		})
		render(<NewTask existingTaskId="task" />)
		expect(useSlashCommands).toHaveBeenLastCalledWith({ hostId: 'host', workspacePath: null, agent: 'claude' })
	})

	it('discovers commands for the selected directory and coding agent', () => {
		const previous = useSettingsStore.getState()
		useSettingsStore.setState({ defaultAgent: 'codelayer', defaultCodelayerProvider: 'codex' })
		try {
			render(<NewTask directory="/code/my-app" />)
			expect(useSlashCommands).toHaveBeenLastCalledWith({
				hostId: 'host',
				workspacePath: '/code/my-app',
				agent: 'codelayer',
			})
		} finally {
			useSettingsStore.setState({
				defaultAgent: previous.defaultAgent,
				defaultCodelayerProvider: previous.defaultCodelayerProvider,
			})
		}
	})
})

describe('first session in an existing task', () => {
	it.each([
		{ workspace_id: 'workspace', default_working_directory: null },
		{ workspace_id: null, default_working_directory: '/code/existing' },
	])('launches without creating another task: %j', async (location) => {
		useTask.mockReturnValue({
			task: { id: 'task', name: 'Task with no sessions', project_id: null, slug: 'task', ...location },
			sessions: [],
			isReady: true,
		})
		render(<NewTask existingTaskId="task" />)
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Start working here' } })
		const start = screen.getByRole('button', { name: 'Start session' })
		expect(start).toBeEnabled()
		fireEvent.click(start)
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[1]).toMatchObject({ id: 'task' })
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({
			hostId: 'host',
			text: 'Start working here',
			workingDirectory: location.default_working_directory ?? '',
		})
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/tasks/$taskId',
				params: { taskId: 'task' },
				search: { session: expect.any(String) },
			}),
		)
	})
})

describe('picking where a new task runs', () => {
	it('keeps a picked directory when the host is picked after it', async () => {
		// With a project to fall back on, losing the directory would launch a project worktree.
		render(<NewTask />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick directory' }))
		fireEvent.click(screen.getByRole('button', { name: 'Pick host' }))
		expect(screen.getByText('In this directory')).toBeInTheDocument()
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prep the weekly update' } })
		fireEvent.click(screen.getByRole('button', { name: 'Start' }))
		await waitFor(() => expect(startTask).toHaveBeenCalledOnce())
		expect(startTask.mock.calls[0]?.[1]).toMatchObject({
			target: { kind: 'directory', path: '/Users/me/repos/self' },
		})
	})
})

describe('picking how big a new task is', () => {
	it('launches the workflow of the picked size and remembers the pick', async () => {
		const { unmount } = render(<NewTask />)
		fireEvent.click(screen.getByRole('button', { name: "Task size: Don't know yet" }))
		fireEvent.click(screen.getByRole('button', { name: /^Medium/ }))
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Add workflow picking' } })
		fireEvent.click(screen.getByRole('button', { name: 'Start' }))
		await waitFor(() => expect(startTask).toHaveBeenCalledOnce())
		expect(startTask.mock.calls[0]?.[1]).toMatchObject({
			workflow: { workflowType: 'outline_only', autoAdvance: true },
		})
		unmount()
		render(<NewTask />)
		expect(screen.getByRole('button', { name: 'Task size: Medium' })).toBeInTheDocument()
	})

	it('launches a small task toward a pull request, with auto-advance that can be turned off', async () => {
		render(<NewTask />)
		fireEvent.click(screen.getByRole('button', { name: "Task size: Don't know yet" }))
		fireEvent.click(screen.getByRole('button', { name: /^Small/ }))
		fireEvent.click(screen.getByRole('button', { name: 'Task size: Small, auto-advance to pull request' }))
		fireEvent.click(screen.getByRole('button', { name: /^Auto-advance to pull request/ }))
		expect(screen.getByRole('button', { name: 'Task size: Small' })).toBeInTheDocument()
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix the typo' } })
		fireEvent.click(screen.getByRole('button', { name: 'Start' }))
		await waitFor(() => expect(startTask).toHaveBeenCalledOnce())
		expect(startTask.mock.calls[0]?.[1]).toMatchObject({
			workflow: { workflowType: 'oneshot', autoAdvance: false },
			directImplementation: true,
		})
	})
})

describe('a new session in a directory task', () => {
	const taskDirectory = '/Users/me/repos/self'

	beforeEach(() => {
		useHosts.mockReturnValue({ hosts: [hostView('mac'), hostView('vm')], isReady: true })
		useTask.mockReturnValue({
			task: {
				id: 'task',
				name: 'Prep the weekly update',
				project_id: null,
				workspace_id: null,
				slug: 'prep-the-weekly-update',
				default_working_directory: taskDirectory,
			},
			sessions: [{ id: 'session', host_id: 'mac', working_directory: taskDirectory }],
			isReady: true,
		})
	})

	function startSession() {
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft the summary' } })
		fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
	}

	it("runs in the task's directory on its own host", async () => {
		render(<NewTask existingTaskId="task" />)
		expect(screen.queryByText('In this directory')).not.toBeInTheDocument()
		// On its own host the directory is a label, not a menu.
		expect(screen.queryByRole('button', { name: 'self' })).not.toBeInTheDocument()
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'mac', workingDirectory: taskDirectory })
	})

	it("moves to a host that has used the task's directory and runs there", async () => {
		useRecentDirectories.mockImplementation((hostId: string | null) =>
			hostId === 'vm' ? ['/home/me/notes', taskDirectory] : [],
		)
		render(<NewTask existingTaskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		expect(screen.getByText('In this directory')).toBeInTheDocument()
		expect(useSlashCommands).toHaveBeenLastCalledWith({
			hostId: 'vm',
			workspacePath: taskDirectory,
			agent: 'claude',
		})
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'vm', workingDirectory: taskDirectory })
	})

	it("moves off an offline task host to one that has used the task's directory", async () => {
		useHosts.mockReturnValue({ hosts: [hostView('mac', false), hostView('vm')], isReady: true })
		useRecentDirectories.mockImplementation((hostId: string | null) => (hostId === 'vm' ? [taskDirectory] : []))
		render(<NewTask existingTaskId="task" />)
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'vm', workingDirectory: taskDirectory })
	})

	it("asks for a directory on a host that hasn't used the task's directory", () => {
		useRecentDirectories.mockImplementation((hostId: string | null) => (hostId === 'vm' ? ['/home/me/notes'] : []))
		render(<NewTask existingTaskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Choose a directory on vm')
		expect(useSlashCommands).toHaveBeenLastCalledWith({ hostId: 'vm', workspacePath: null, agent: 'claude' })
		startSession()
		expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled()
		expect(launchInTask).not.toHaveBeenCalled()
	})

	it('runs in a recent directory chosen on the new host', async () => {
		useRecentDirectories.mockImplementation((hostId: string | null) => (hostId === 'vm' ? ['/home/me/notes'] : []))
		render(<NewTask existingTaskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		fireEvent.click(screen.getByRole('button', { name: 'Choose a directory' }))
		expect(screen.getByText('Directories on vm')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: /^notes/ }))
		expect(screen.queryByText('Directories on vm')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'notes' })).toBeInTheDocument()
		expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask the agent to do anything')
		expect(useSlashCommands).toHaveBeenLastCalledWith({
			hostId: 'vm',
			workspacePath: '/home/me/notes',
			agent: 'claude',
		})
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'vm', workingDirectory: '/home/me/notes' })
	})

	it('runs in a path typed for the new host', async () => {
		render(<NewTask existingTaskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		fireEvent.click(screen.getByRole('button', { name: 'Choose a directory' }))
		const path = screen.getByRole('textbox', { name: 'Directory path' })
		expect(path).toHaveAttribute('placeholder', 'Path on vm, e.g. ~/code/app')
		fireEvent.change(path, { target: { value: ' /srv/weekly ' } })
		fireEvent.click(screen.getByRole('button', { name: 'Use directory' }))
		expect(screen.getByRole('button', { name: 'weekly' })).toBeInTheDocument()
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'vm', workingDirectory: '/srv/weekly' })
	})

	it("goes back to the task's directory on its own host and drops the chosen one", async () => {
		useRecentDirectories.mockImplementation((hostId: string | null) => (hostId === 'vm' ? ['/home/me/notes'] : []))
		render(<NewTask existingTaskId="task" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		fireEvent.click(screen.getByRole('button', { name: 'Choose a directory' }))
		fireEvent.click(screen.getByRole('button', { name: /^notes/ }))
		fireEvent.click(screen.getByRole('button', { name: 'Pick mac' }))
		expect(screen.queryByRole('button', { name: 'notes' })).not.toBeInTheDocument()
		// Back on the other host, the directory has to be chosen again.
		fireEvent.click(screen.getByRole('button', { name: 'Pick vm' }))
		expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Choose a directory on vm')
		fireEvent.click(screen.getByRole('button', { name: 'Pick mac' }))
		startSession()
		await waitFor(() => expect(launchInTask).toHaveBeenCalledOnce())
		expect(launchInTask.mock.calls[0]?.[2]).toMatchObject({ hostId: 'mac', workingDirectory: taskDirectory })
	})
})

describe('saving a new task as a draft', () => {
	it('creates the ticket in the column it came from, without starting it, and goes back to the board', async () => {
		render(<NewTask directory="/code/my-app" status="backlog" />)
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix the flaky upload test' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
		await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/board' }))
		expect(saveDraft).toHaveBeenCalledOnce()
		expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({
			name: 'Fix the flaky upload test',
			status: 'backlog',
			defaultWorkingDirectory: '/code/my-app',
			worktreeTiming: 'never',
			workflowType: 'oneshot',
			ticketProvider: null,
			draftLaunch: {
				version: 1,
				prompt: 'Fix the flaky upload test',
				attachments: [],
				target: { kind: 'directory', path: '/code/my-app' },
				hostId: 'host',
				taskSize: 'unknown',
				smallAutoAdvance: true,
				settings: expect.objectContaining({ agent: 'claude' }),
			},
		})
		expect(confirmTasks).toHaveBeenCalledWith('42')
		expect(startTask).not.toHaveBeenCalled()
		expect(screen.getByRole('textbox')).toHaveValue('')
	})

	it('files a draft from the plain new-task page in Todo and opens it', async () => {
		render(<NewTask directory="/code/my-app" />)
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Write the release notes' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
		await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
		const input = saveDraft.mock.calls[0]?.[0] as { id: string; status: string }
		expect(input.status).toBe('todo')
		await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { task: input.id } }))
	})

	it('saves for an offline host, which blocks only Start', async () => {
		useHosts.mockReturnValue({ hosts: [hostView('host', false)], isReady: true })
		render(<NewTask directory="/code/my-app" status="todo" />)
		fireEvent.click(screen.getByRole('button', { name: 'Pick host' }))
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Later, on my laptop' } })
		expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'host is offline')
		expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
		fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
		await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
		expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({ draftLaunch: { hostId: 'host' } })
	})

	it('keeps the prompt when the draft cannot be saved', async () => {
		saveDraft.mockResolvedValue({ result: 'draft-id-unavailable' })
		render(<NewTask directory="/code/my-app" status="todo" />)
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
		await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
		expect(navigate).not.toHaveBeenCalled()
		expect(screen.getByRole('textbox')).toHaveValue('Keep me')
	})
})

describe('an opened draft', () => {
	const draftId = '019ab7c2-4f1e-7000-8000-00000000d1a7'
	const draftTask = {
		id: draftId,
		name: 'Retry the webhook',
		slug: 'retry-the-webhook-d1a7',
		is_draft: true,
		status: 'todo',
		project_id: null,
		workspace_id: null,
		default_working_directory: '/code/app',
		ticket_provider: null,
		ticket_id: null,
		ticket_url: null,
		github_connection_id: null,
		ticket_repository_id: null,
		ticket_repository_full_name: null,
		draft_launch: {
			version: 1,
			prompt: 'Retry the webhook with backoff',
			attachments: [],
			target: { kind: 'directory', path: '/code/app' },
			hostId: 'host',
			settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'default' },
			taskSize: 'medium',
			smallAutoAdvance: true,
		},
	}

	beforeEach(() => {
		useTask.mockReturnValue({ task: draftTask, sessions: [], isReady: true })
	})

	it('reopens the composer with what it saved, and Start launches it in place, keeping its column', async () => {
		render(<NewTask existingTaskId={draftId} />)
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('What should we work on in app?')
		expect(screen.getByRole('textbox')).toHaveValue('Retry the webhook with backoff')
		expect(screen.getByRole('button', { name: 'Task size: Medium' })).toBeInTheDocument()
		// A draft is already saved; there's nothing behind the caret.
		expect(screen.queryByRole('button', { name: 'Save as draft' })).not.toBeInTheDocument()
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retry the webhook with jitter' } })
		fireEvent.click(screen.getByRole('button', { name: 'Start' }))
		await waitFor(() => expect(startTask).toHaveBeenCalledOnce())
		const input = startTask.mock.calls[0]?.[1]
		expect(input).toMatchObject({
			ids: { taskId: draftId },
			target: { kind: 'directory', path: '/code/app' },
			hostId: 'host',
			draft: 'Retry the webhook with jitter',
			workflow: { workflowType: 'outline_only', autoAdvance: true },
			directImplementation: false,
		})
		expect(input).not.toHaveProperty('status')
		expect(launchInTask).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith({ to: '/tasks/$taskId', params: { taskId: draftId } })
	})

	it('keeps its own size pick off this device', () => {
		render(<NewTask existingTaskId={draftId} />)
		fireEvent.click(screen.getByRole('button', { name: 'Task size: Medium' }))
		fireEvent.click(screen.getByRole('button', { name: /^Large/ }))
		expect(screen.getByRole('button', { name: 'Task size: Large' })).toBeInTheDocument()
		cleanup()
		useTask.mockReturnValue({ task: null, sessions: [], isReady: true })
		render(<NewTask />)
		expect(screen.getByRole('button', { name: "Task size: Don't know yet" })).toBeInTheDocument()
	})

	it('says so instead of guessing when a newer version saved it', () => {
		useTask.mockReturnValue({
			task: { ...draftTask, draft_launch: { ...draftTask.draft_launch, version: 2 } },
			sessions: [],
			isReady: true,
		})
		render(<NewTask existingTaskId={draftId} />)
		expect(screen.getByRole('textbox')).toHaveAttribute(
			'placeholder',
			'This draft was saved by a newer version of devflow. Reload to open it.',
		)
		expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
	})

	it('opens a draft without a snapshot, from the standard launcher, as before', () => {
		useTask.mockReturnValue({
			task: { ...draftTask, draft_launch: null },
			sessions: [],
			isReady: true,
		})
		render(<NewTask existingTaskId={draftId} />)
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New session in Retry the webhook')
	})
})
