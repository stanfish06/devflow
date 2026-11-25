import type { TaskStatus } from '@devflow/schemas/effect/taskconfiguration'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
	ChevronDown,
	Folder,
	FolderGit2,
	GitBranch,
	House,
	PanelLeft,
	Route,
	Server,
	SkipForward,
	Ticket as TicketIcon,
	X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { uuidv7 } from 'uuidv7'

import { useSyncInternal } from '@/components/providers/SyncProvider'
import { missingRepositorySources } from '@/lib/repository-sources'
import { Avatar } from '@/minimalist/components/Avatar'
import { Composer } from '@/minimalist/components/Composer'
import { GithubAccountMenu } from '@/minimalist/components/GithubAccountMenu'
import { IssueDialog } from '@/minimalist/components/IssueDialog'
import { DirectoryMenu, HostIcon, HostMenu, TargetMenu } from '@/minimalist/components/LaunchMenus'
import { Menu, MenuItem, MenuSeparator } from '@/minimalist/components/Menu'
import { DraftMark } from '@/minimalist/components/TaskItem'
import { TASK_STATUS_META } from '@/minimalist/components/TaskStatusIcon'
import { WiredTaskNavigation } from '@/minimalist/components/WiredTaskNavigation'
import { withAttachments } from '@/minimalist/lib/attachments'
import {
	DAEMON_START_COMMAND,
	useHosts,
	useProjects,
	useRecentDirectories,
	useSlashCommands,
	useTask,
	useTaskTree,
} from '@/minimalist/lib/data'
import { draftStartBlocker } from '@/minimalist/lib/draft-blocker'
import { newTaskDraftKey } from '@/minimalist/lib/drafts'
import { basename, formatAgo, toMs } from '@/minimalist/lib/format'
import {
	type GithubAccountPick,
	githubAccountLabel,
	pickOf,
	type ResolvedGithubAccount,
	resolveGithubAccount,
	useGithubAccounts,
} from '@/minimalist/lib/github-accounts'
import {
	defaultTarget,
	ensureRepositorySources,
	launchBlocker,
	launchError,
	launchInTask,
	launchHost,
	type LoadedTarget,
	rememberSettings,
	startTask,
	type Target,
	targetLabel,
	workingCopy,
} from '@/minimalist/lib/launch'
import {
	draftSaveInput,
	draftTarget,
	fromDraftLaunch,
	isBoardDraft,
	launchInput,
	toDraftLaunch,
	useLaunchForm,
} from '@/minimalist/lib/launch-form'
import { fitSettings, modelCatalog } from '@/minimalist/lib/models'
import { TASK_SIZES, type TaskSize, taskSizeOption } from '@/minimalist/lib/task-size'
import { githubFullName, type Ticket, ticketLabel } from '@/minimalist/lib/tickets'
import { useUi } from '@/minimalist/lib/ui-state'
import { useCopy } from '@/minimalist/lib/use-copy'
import { type DraftAutosaveState, useDraftAutosave } from '@/minimalist/lib/use-draft-autosave'
import { useWorkingHost } from '@/minimalist/lib/use-working-host'
import { useApi } from '@/orpc/client'

type NewTaskProps = {
	existingTaskId?: string
	projectId?: string
	directory?: string
	/** A host to start on, such as the one the offline notice offers. */
	hostId?: string
	/** Board status for the new task, from a board column's +. */
	status?: TaskStatus
}

/**
 * What the page launches: a new task, a board draft saved earlier (`?task=` a draft with a
 * snapshot), or a new session in a task. A task still loading reads as a session until it arrives.
 */
type LaunchMode = 'new' | 'draft' | 'session'

/**
 * The new-task page. A new task Starts, or saves as a draft for later; a draft reopens here with
 * everything it saved, and Starts in place; a task gets a new session.
 */
export function NewTask(props: NewTaskProps) {
	const existing = useTask(props.existingTaskId)
	// An open draft stays one while it starts, though its row turns into a launched task first.
	const [openedDraft, setOpenedDraft] = useState(false)
	if (props.existingTaskId && !openedDraft && isBoardDraft(existing.task)) setOpenedDraft(true)
	const mode: LaunchMode = !props.existingTaskId
		? 'new'
		: openedDraft || isBoardDraft(existing.task)
			? 'draft'
			: 'session'
	// Each mode seeds its form once, so a task that turns out to be a draft opens fresh.
	return <LaunchPage key={mode} {...props} mode={mode} existing={existing} />
}

function LaunchPage({
	existingTaskId,
	projectId,
	directory,
	hostId: requestedHostId,
	status,
	mode,
	existing,
}: NewTaskProps & { mode: LaunchMode; existing: ReturnType<typeof useTask> }) {
	const { client: api, queryClient: orpc } = useApi()
	const { confirmTx } = useSyncInternal()
	const navigate = useNavigate()
	const { showToast, taskSidebarOpen, toggleTaskSidebar } = useUi()
	const { hosts, isReady: hostsReady } = useHosts()
	const projects = useProjects()
	const { recent } = useTaskTree()
	/** A new session in a task, as opposed to a task that hasn't launched yet. */
	const inTask = mode === 'session'
	// A draft opens with what it saved, read once: later syncs of the row never overwrite the editor.
	const [opened] = useState(() => (mode === 'draft' && existing.task ? fromDraftLaunch(existing.task) : null))
	const [ids] = useState(() => ({
		taskId: mode === 'draft' && existing.task ? existing.task.id : uuidv7(),
		sessionId: uuidv7(),
		eventId: uuidv7(),
	}))
	const form = useLaunchForm({
		seed: opened?.seed ?? null,
		textKey: newTaskDraftKey(existingTaskId),
		hostId: requestedHostId,
		uploads: { taskId: inTask && existingTaskId ? existingTaskId : ids.taskId, existing: inTask },
	})
	const { attachments, ticket } = form
	const latestExisting = existing.sessions.at(-1) ?? null
	const existingWorkspace = useQuery({
		...orpc.projectWorkspaces.getStatus.queryOptions({
			input: { taskId: existingTaskId ?? '' },
			context: { silent: true },
		}),
		enabled: Boolean(existingTaskId && existing.task?.workspace_id),
	})
	const existingProjectId = existing.task?.workspace_id
		? existingWorkspace.data?.workspace.projectId
		: existing.task?.project_id
	const taskHost = hosts.find((entry) => entry.host.host_id === latestExisting?.host_id) ?? null
	// Until you pick, a new task starts on the working host; this composer only reads it, so picking
	// here never changes it. A session in a task keeps the task's host.
	const working = useWorkingHost()
	const seedHostId = mode === 'new' && working.id !== 'all' ? working.id : null
	const seedOffline =
		form.hostId === null && seedHostId !== null && working.state === 'offline' ? working.host : null
	// A draft runs on the host it was saved for, or one picked for it here; never on another by default.
	const host =
		mode === 'draft'
			? (hosts.find((entry) => entry.host.host_id === form.hostId) ?? null)
			: launchHost(hosts, {
					picked: form.hostId ?? seedHostId,
					task: inTask && latestExisting?.host_id ? { hostId: latestExisting.host_id } : null,
				})
	const directories = useRecentDirectories(host?.host.host_id ?? null)
	const taskDirectory = latestExisting?.working_directory ?? existing.task?.default_working_directory ?? null
	const moved = Boolean(inTask && host && latestExisting?.host_id && host.host.host_id !== latestExisting.host_id)
	const directoryTask = Boolean(inTask && existing.task && !existing.task.workspace_id)
	// A directory chosen for a moved directory task belongs to the host it was chosen on.
	const [pickedDirectory, setPickedDirectory] = useState<{ hostId: string; path: string } | null>(null)
	const sessionDirectory = resolveSessionDirectory({
		taskDirectory,
		moved,
		directoryTask,
		directories,
		picked: pickedDirectory && pickedDirectory.hostId === host?.host.host_id ? pickedDirectory.path : null,
	})
	const [issueDialog, setIssueDialog] = useState(false)
	const [launching, setLaunching] = useState(false)
	const launchLock = useRef(false)
	const catalog = modelCatalog(host?.host)
	const settings = fitSettings(form.settings, catalog)
	const [menu, setMenu] = useState<'target' | 'host' | 'directory' | 'account' | null>(null)
	const targetAnchor = useRef<HTMLButtonElement>(null)
	const directoryAnchor = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (!inTask || !taskSidebarOpen || !matchMedia('(max-width: 1050px)').matches) return
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
		const frame = requestAnimationFrame(() =>
			document.querySelector<HTMLElement>('.task-nav button, .task-nav a')?.focus(),
		)
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') toggleTaskSidebar()
		}
		window.addEventListener('keydown', escape)
		return () => {
			cancelAnimationFrame(frame)
			window.removeEventListener('keydown', escape)
			opener?.focus()
		}
	}, [inTask, taskSidebarOpen, toggleTaskSidebar])
	const hostAnchor = useRef<HTMLButtonElement>(null)
	const accountAnchor = useRef<HTMLButtonElement>(null)

	const namedProject = (id: string): Target | null => {
		const project = projects.data?.find((entry) => entry.id === id)
		return project ? { kind: 'project', projectId: project.id, name: project.name } : null
	}
	const picked: Target | null =
		form.target?.kind === 'project' ? namedProject(form.target.projectId) : (form.target ?? null)
	const requested: Target | null = projectId
		? namedProject(projectId)
		: directory
			? { kind: 'directory', path: directory }
			: null
	// A project named in the address, or saved with a draft, is where the task goes, so wait for it
	// rather than guess another.
	const awaitingProject = Boolean(projectId || form.target?.kind === 'project') && projects.isPending
	// A draft runs where it was saved for; if that project is gone, it asks rather than defaulting.
	const effectiveTarget =
		picked ??
		requested ??
		(awaitingProject || mode === 'draft'
			? null
			: defaultTarget({ latest: recent[0], directory: directories[0], project: projects.data?.[0] }))
	const targetProject =
		effectiveTarget?.kind === 'project'
			? projects.data?.find((project) => project.id === effectiveTarget.projectId)
			: undefined
	// The account a new task pushes as: the one you pick here, else the project's default, else yours.
	// Only a pick is sent, so an untouched task keeps following the defaults if they change later.
	const githubAccounts = useGithubAccounts()
	const [accountPick, setAccountPick] = useState<{ pick: GithubAccountPick } | null>(null)
	const projectDefaultId =
		effectiveTarget?.kind === 'project' ? githubAccounts.projectDefaults[effectiveTarget.projectId] : undefined
	const account = resolveGithubAccount({
		accounts: githubAccounts.accounts,
		task: accountPick ? accountPick.pick : undefined,
		project: projectDefaultId,
		defaultAccountId: githubAccounts.defaultAccountId,
	})
	// Without any accounts there is nothing to choose but each host's own login, as before.
	const showAccount = !existingTaskId && (githubAccounts.accounts.length > 0 || accountPick !== null)
	const workspace: LoadedTarget | null =
		effectiveTarget?.kind === 'directory'
			? effectiveTarget
			: targetProject
				? { kind: 'project', project: targetProject }
				: null
	const composerDirectory = inTask
		? sessionDirectory
		: effectiveTarget?.kind === 'directory'
			? effectiveTarget.path
			: null
	const commands = useSlashCommands({
		hostId: host?.host.host_id ?? null,
		workspacePath: composerDirectory,
		agent: settings.agent,
	})
	const sourceInput = {
		projectId: inTask
			? (existingProjectId ?? '')
			: effectiveTarget?.kind === 'project'
				? effectiveTarget.projectId
				: '',
		hostId: host?.host.host_id ?? '',
	}
	const sources = useQuery({
		...orpc.projects.v2.repositorySources.get.queryOptions({ input: sourceInput, context: { silent: true } }),
		enabled: Boolean(sourceInput.projectId && sourceInput.hostId),
	})
	// A project repository with no checkout on this host is cloned by the host on first launch.
	const copy = workingCopy({
		inTask,
		project: inTask ? Boolean(existing.task?.workspace_id) : effectiveTarget?.kind === 'project',
		clonesFirst: missingRepositorySources(sources.data?.sources).length > 0,
		hostName: host?.name ?? 'The host',
		movedFrom: host && taskHost && host !== taskHost ? taskHost.name : null,
	})
	const targetName = inTask ? (existing.task?.name ?? null) : targetLabel(effectiveTarget)
	let blocker =
		mode === 'draft'
			? draftStartBlocker({ hostId: form.hostId, target: form.target }, hosts, projects.data)
			: launchBlocker({ host, needsTarget: !inTask, target: effectiveTarget })
	if (opened?.error) blocker = opened.error
	else if (!hostsReady || awaitingProject) blocker = 'Loading…'
	else if (existingTaskId && !existing.isReady) blocker = 'Loading task…'
	else if (inTask && !existing.task) blocker = "This task doesn't exist"
	else if (inTask && existing.task?.workspace_id && existingWorkspace.isPending) blocker = 'Loading workspace…'
	else if (inTask && existing.task?.workspace_id && existingWorkspace.isError)
		blocker = 'Could not load workspace. Refresh this task and try again.'
	else if (
		inTask &&
		!existing.task?.workspace_id &&
		!latestExisting?.working_directory &&
		!existing.task?.default_working_directory
	)
		blocker = 'Choose a task with a workspace or directory'
	else if (host && moved && directoryTask && !sessionDirectory) blocker = `Choose a directory on ${host.name}`

	// The composer as a draft would save it, and as Start launches it. An open draft keeps its own
	// target by id, so it still saves while its project loads or after it's gone, and the settings
	// picked for it, which Start then fits to what the host can run.
	const snapshotTarget = mode === 'draft' ? form.target : effectiveTarget && draftTarget(effectiveTarget)
	const snapshot = snapshotTarget
		? toDraftLaunch({
				text: form.text,
				target: snapshotTarget,
				hostId: host?.host.host_id ?? form.hostId ?? '',
				settings: mode === 'draft' ? form.settings : settings,
				taskSize: form.taskSize,
				smallAutoAdvance: form.smallAutoAdvance,
				attachments: attachments.metadata,
			})
		: null
	const hasContent = Boolean(form.text.trim() || attachments.metadata.length > 0 || (ticket && !inTask))
	// A snapshot from a newer version opens blank: saving would overwrite what it can't read.
	const autosave = useDraftAutosave(
		mode === 'draft' && existing.task && !opened?.error ? ids.taskId : null,
		snapshot,
		{ ticket, status: existing.task?.status ?? 'todo' },
	)

	const launch = async () => {
		if (!hasContent || !host || blocker || launchLock.current || attachments.blocked) return
		launchLock.current = true
		setLaunching(true)
		const hostId = host.host.host_id
		try {
			// The row holds exactly what launches, and no save is left to land on a started task.
			if (mode === 'draft') await autosave.flush()
			if (inTask && existingTaskId && existing.task) {
				if (existingProjectId && hostId !== latestExisting?.host_id)
					await ensureRepositorySources(api, existingProjectId, hostId)
				await launchInTask(api, existing.task, {
					sessionId: ids.sessionId,
					eventId: ids.eventId,
					text: withAttachments(form.text, existing.task.slug ?? '', attachments.metadata),
					hostId,
					workingDirectory: sessionDirectory ?? taskDirectory ?? '',
					settings,
				})
				rememberSettings(settings)
				form.setText('')
				void navigate({
					to: '/tasks/$taskId',
					params: { taskId: existingTaskId },
					search: { session: ids.sessionId },
				})
				return
			}
			if (!workspace || !snapshot) throw new Error('project not loaded')
			// A draft starts in place, with what's on screen, and keeps its column; a new task takes
			// the column it was created from, and the account picked for it.
			await startTask(
				api,
				launchInput({
					ids,
					target: workspace,
					snapshot: { ...snapshot, settings },
					ticket,
					status: mode === 'new' ? status : undefined,
					githubAccount:
						mode === 'new' ? { id: pickOf(account), explicit: accountPick !== null } : undefined,
				}),
			)
			if (mode === 'new') {
				rememberSettings(settings)
				form.setText('')
			}
			void navigate({ to: '/tasks/$taskId', params: { taskId: ids.taskId } })
		} catch (error) {
			showToast(launchError(error))
		} finally {
			launchLock.current = false
			setLaunching(false)
		}
	}

	/** Creates the ticket in its column without starting anything; Start comes later, from the board or here. */
	const saveAsDraft = async () => {
		if (!hasContent || launchLock.current || attachments.blocked) return
		if (!snapshot) {
			showToast(
				!hostsReady || awaitingProject
					? 'Still loading. Save the draft again in a moment.'
					: 'Choose a project or directory for the draft.',
			)
			return
		}
		launchLock.current = true
		setLaunching(true)
		try {
			const saved = await api.tasks.saveDraft(
				// From the plain new-task page a draft is queued work: Todo.
				draftSaveInput({ taskId: ids.taskId, snapshot, ticket, status: status ?? 'todo' }),
				{ context: { silent: true } },
			)
			if (saved.result !== 'saved') throw new Error('This draft id is already taken')
			// Wait for the row, so the board shows the card and the draft opens straight away.
			await confirmTx.tasks(saved.transactionId).catch(() => null)
			form.setText('')
			// From a column's +, back to the board; otherwise, to the draft.
			void navigate(status ? { to: '/board' } : { to: '/', search: { task: ids.taskId } })
		} catch {
			showToast('Could not save the draft. Your prompt is still in the composer.')
		} finally {
			launchLock.current = false
			setLaunching(false)
		}
	}

	/**
	 * Deletes an open draft at once, with Undo: a draft has no agent work to lose. It's archived,
	 * after its last edits save, so Undo brings it back as it was, in its column.
	 */
	const deleteDraft = async () => {
		if (launchLock.current) return
		launchLock.current = true
		setLaunching(true)
		const archive = (archived: boolean) =>
			api.tasks.archive({ taskId: ids.taskId, archived, cascadeToSessions: false })
		try {
			// Undo restores the row, so archive only once the row holds the latest edits.
			if (!(await autosave.flush())) throw new Error('draft edits not saved')
			await archive(true)
			showToast('Draft deleted', {
				label: 'Undo',
				run: () =>
					void archive(false).then(
						() => showToast('Draft restored'),
						() => showToast('Could not restore the draft. Try again.'),
					),
			})
			void navigate({ to: '/board' })
		} catch {
			showToast('Could not delete the draft. Try again.')
		} finally {
			launchLock.current = false
			setLaunching(false)
		}
	}

	const strip = (
		<div className="envstrip">
			{moved && directoryTask ? (
				<button
					type="button"
					ref={directoryAnchor}
					title={sessionDirectory ?? undefined}
					onClick={() => setMenu('directory')}
				>
					<FolderGit2 className="i sm" strokeWidth={1.6} />
					{sessionDirectory ? basename(sessionDirectory) : 'Choose a directory'}
					<ChevronDown className="i sm" />
				</button>
			) : inTask ? (
				<span>
					<FolderGit2 className="i sm" strokeWidth={1.6} />
					{latestExisting
						? basename(latestExisting.working_directory)
						: existing.isReady
							? 'No session'
							: 'Loading…'}
				</span>
			) : (
				<button
					type="button"
					ref={targetAnchor}
					aria-label={`Project: ${targetName ?? 'none'}`}
					onClick={() => setMenu('target')}
				>
					<Folder className="i sm" strokeWidth={1.6} />
					{targetName ?? 'Choose a project'}
					<ChevronDown className="i sm" />
				</button>
			)}
			<button
				type="button"
				ref={hostAnchor}
				aria-label={`Host: ${host ? host.name : 'none'}`}
				title={seedOffline ? offlineSeedCopy(seedOffline.name) : undefined}
				onClick={() => setMenu('host')}
			>
				<HostIcon host={host} />
				{host ? host.name : hostsReady ? 'No host' : 'Host'}
				<ChevronDown className="i sm" />
			</button>
			{showAccount ? (
				<button
					type="button"
					ref={accountAnchor}
					aria-label={`GitHub account: ${githubAccountLabel(account)}`}
					title={accountTitle(account)}
					onClick={() => setMenu('account')}
				>
					{account.account === 'host' ? (
						<House className="i sm" strokeWidth={1.6} />
					) : (
						<Avatar name={account.account.login} size={14} />
					)}
					{githubAccountLabel(account)}
					<ChevronDown className="i sm" />
				</button>
			) : null}
			{copy ? (
				<span className="muted wc" title={copy.title}>
					<WorkingCopyIcon branch={copy.branch} />
					{copy.label}
				</span>
			) : null}
			{ticket && !inTask ? <IssueChip ticket={ticket} onRemove={() => form.setTicket(null)} /> : null}
			{inTask ? null : (
				<TaskSizePicker
					size={form.taskSize}
					onPick={form.setTaskSize}
					smallAutoAdvance={form.smallAutoAdvance}
					onSmallAutoAdvance={form.setSmallAutoAdvance}
				/>
			)}
		</div>
	)

	const page = (
		<main className="main" tabIndex={-1}>
			<div className="titlebar">
				{mode === 'draft' && existing.task ? (
					<>
						<span className="title">{existing.task.name || 'Untitled draft'}</span>
						<DraftMark />
						<span className="crumb">· {TASK_STATUS_META[existing.task.status].label}</span>
						<span className="sp" />
						<span className="draft-saved">
							{savedLabel(autosave.state, autosave.savedAt ?? toMs(existing.task.updated_at))}
						</span>
						<button
							type="button"
							className="btn ghost"
							disabled={launching}
							onClick={() => void deleteDraft()}
						>
							Delete draft
						</button>
					</>
				) : (
					<span className="sp" />
				)}
			</div>
			{inTask ? (
				<div className="hero">
					<h1>New session in {targetName ?? 'this task'}</h1>
				</div>
			) : (
				<Hero name={targetName} onPickTarget={() => setMenu('target')} />
			)}
			<div className="col">
				{hostsReady && hosts.length === 0 ? <NoHostsNotice /> : null}
				{seedOffline ? (
					<OfflineWorkingHostNotice name={seedOffline.name} onPick={() => setMenu('host')} />
				) : null}
				<Composer
					value={form.text}
					onChange={form.setText}
					onSubmit={() => void launch()}
					onSaveDraft={mode === 'new' ? () => void saveAsDraft() : undefined}
					placeholder={
						blocker ??
						(ticket && !inTask
							? `Add instructions for ${ticketLabel(ticket)}, or send to start`
							: 'Ask the agent to do anything')
					}
					disabled={launching}
					submitDisabled={Boolean(blocker)}
					attachments={attachments}
					submitLabel={inTask ? 'Start session' : 'Start'}
					settings={settings}
					onSettingsChange={form.setSettings}
					catalog={catalog}
					usage={
						host ? { hostName: host.name, limits: host.host.coding_agent_usage_limits?.claude } : undefined
					}
					autoFocus
					commands={commands}
					onAddIssue={inTask ? undefined : () => setIssueDialog(true)}
					hasIssue={Boolean(ticket) && !inTask}
					mentionScope={{ taskId: inTask ? (existingTaskId ?? null) : null }}
				>
					{strip}
				</Composer>
			</div>
			<TargetMenu
				anchor={targetAnchor}
				open={menu === 'target'}
				onClose={() => setMenu(null)}
				host={host}
				target={effectiveTarget}
				onPick={(next) => form.setTarget(draftTarget(next))}
			/>
			<HostMenu
				anchor={hostAnchor}
				open={menu === 'host'}
				onClose={() => setMenu(null)}
				selectedId={host?.host.host_id ?? null}
				// A picked directory stays picked. Dropping it fell back to the default target, often a
				// project, and launched a worktree of the wrong repository instead of running in place.
				// A directory chosen for a session in a task is only good on its host, so it goes.
				onPick={(id) => {
					form.setHostId(id)
					if (id !== host?.host.host_id) setPickedDirectory(null)
				}}
			/>
			<GithubAccountMenu
				anchor={accountAnchor}
				open={menu === 'account'}
				onClose={() => setMenu(null)}
				value={pickOf(account)}
				projectDefaultId={projectDefaultId}
				hostName={host?.name}
				onPick={(pick) => setAccountPick({ pick })}
			/>
			<DirectoryMenu
				anchor={directoryAnchor}
				open={menu === 'directory'}
				onClose={() => setMenu(null)}
				host={host}
				selected={sessionDirectory}
				onPick={(path) => {
					if (host) setPickedDirectory({ hostId: host.host.host_id, path })
				}}
			/>
			{issueDialog ? (
				<IssueDialog
					projectRepository={githubFullName(
						targetProject?.repositories.find((repository) => repository.default)?.repositoryIdentity,
					)}
					onAttach={form.setTicket}
					onClose={() => setIssueDialog(false)}
				/>
			) : null}
		</main>
	)
	return inTask && existingTaskId ? (
		<div className="task-layout">
			<WiredTaskNavigation taskId={existingTaskId} />
			{taskSidebarOpen ? (
				<button
					className="task-nav-scrim"
					type="button"
					aria-label="Close task navigation"
					onClick={toggleTaskSidebar}
				/>
			) : null}
			<div className="task-content">
				<div className="task-content-bar">
					<button
						type="button"
						className="iconbtn"
						aria-label="Open task navigation"
						aria-expanded={taskSidebarOpen}
						onClick={toggleTaskSidebar}
					>
						<PanelLeft className="i" />
					</button>
					<span className="t">{existing.task?.name}</span>
				</div>
				{page}
			</div>
		</div>
	) : (
		page
	)
}

/**
 * The directory a new session in a task runs in. On the task's host it is the task's directory.
 * On another host, a project task's workspace is set up again by the server (null here). A
 * directory task uses the directory you chose on that host; without one, it keeps its own
 * directory only when that host has used it recently, and otherwise has none until you choose.
 */
function resolveSessionDirectory(state: {
	taskDirectory: string | null
	moved: boolean
	directoryTask: boolean
	directories: readonly string[]
	picked: string | null
}): string | null {
	if (!state.moved) return state.taskDirectory
	if (!state.directoryTask) return null
	if (state.picked) return state.picked
	if (!state.taskDirectory) return null
	return state.directories.includes(state.taskDirectory) ? state.taskDirectory : null
}

/** The open draft's quiet save hint: saving, when it last saved, or that the last save didn't land. */
function savedLabel(state: DraftAutosaveState, savedAt: number): string {
	if (state === 'saving') return 'Saving…'
	if (state === 'error') return 'Draft not saved'
	return savedAt ? `Draft saved · ${formatAgo(savedAt)}` : ''
}

/** The greeting over the composer, naming the selected project or directory. */
function Hero({ name, onPickTarget }: { name: string | null; onPickTarget?: () => void }) {
	return (
		<div className="hero">
			<h1>
				{name ? (
					<>
						What should we work on in{' '}
						<u>
							{onPickTarget ? (
								<button type="button" onClick={onPickTarget}>
									{name}
								</button>
							) : (
								name
							)}
						</u>
						?
					</>
				) : (
					'What should we work on?'
				)}
			</h1>
		</div>
	)
}

/** The issue a new task starts from, linked, with a button to drop it. */
function IssueChip({ ticket, onRemove }: { ticket: Ticket; onRemove: () => void }) {
	return (
		<span className="issue-chip" title={ticket.name}>
			<TicketIcon className="i sm" strokeWidth={1.6} />
			{ticket.url ? (
				<a href={ticket.url} target="_blank" rel="noreferrer" className="ell">
					{ticket.name}
				</a>
			) : (
				<span className="ell">{ticket.name}</span>
			)}
			<button type="button" aria-label={`Remove ${ticketLabel(ticket)}`} onClick={onRemove}>
				<X className="i sm" />
			</button>
		</span>
	)
}

/** Nothing can launch until a daemon runs somewhere; the same card the thread shows for an offline host. */
function NoHostsNotice() {
	const copy = useCopy()
	return (
		<div className="notice" role="status">
			<Server className="i sm" strokeWidth={1.6} />
			<div className="body">
				<b>No hosts online</b>
				<div className="d">Start a daemon where your code lives to launch tasks.</div>
				<div className="acts">
					<button
						type="button"
						className="btn"
						title={DAEMON_START_COMMAND}
						onClick={() =>
							copy(
								DAEMON_START_COMMAND,
								'Start command copied. Run it in a terminal.',
								`Could not copy the command. Run ${DAEMON_START_COMMAND} in a terminal.`,
							)
						}
					>
						Copy start command
					</button>
				</div>
			</div>
		</div>
	)
}

/** Where the composer's account comes from, for its tooltip. */
function accountTitle(account: ResolvedGithubAccount): string {
	const who = account.account === 'host' ? "each host's own gh login" : account.account.login
	switch (account.source) {
		case 'task':
			return `Pushes and opens PRs as ${who}`
		case 'project':
			return `Pushes and opens PRs as ${who}, the project's default`
		case 'default':
			return `Pushes and opens PRs as ${who}, your default`
		case 'host':
			return "Pushes and opens PRs as each host's own gh login"
	}
}

function offlineSeedCopy(name: string) {
	return `${name} is offline — pick a host for this launch`
}

/** The working host is offline. Say so and offer another host for this launch, without changing it. */
function OfflineWorkingHostNotice({ name, onPick }: { name: string; onPick: () => void }) {
	return (
		<div className="notice" role="status">
			<Server className="i sm" strokeWidth={1.6} />
			<div className="body">
				<b>{offlineSeedCopy(name)}</b>
				<div className="d">Your working host stays {name}. The host you pick is used for this task only.</div>
				<div className="acts">
					<button type="button" className="btn" onClick={onPick}>
						Pick a host
					</button>
				</div>
			</div>
		</div>
	)
}

/**
 * How big the new task is, which picks its workflow; small tasks also choose whether the pull
 * request follows on its own. A new task's picks stick on this device; a draft's stay with it.
 */
function TaskSizePicker({
	size,
	onPick,
	smallAutoAdvance,
	onSmallAutoAdvance,
}: {
	size: TaskSize
	onPick: (size: TaskSize) => void
	smallAutoAdvance: boolean
	onSmallAutoAdvance: (on: boolean) => void
}) {
	const anchor = useRef<HTMLButtonElement>(null)
	const [open, setOpen] = useState(false)
	const current = taskSizeOption(size)
	const autoPr = size === 'small' && smallAutoAdvance
	return (
		<>
			<button
				type="button"
				className="task-size"
				ref={anchor}
				aria-label={`Task size: ${current.label}${autoPr ? ', auto-advance to pull request' : ''}`}
				title={autoPr ? `${current.description}\nAuto-advances to the pull request` : current.description}
				onClick={() => setOpen(true)}
			>
				<Route className="i sm" strokeWidth={1.6} />
				{current.label}
				{autoPr ? <SkipForward className="i sm task-size-auto" strokeWidth={1.6} fill="currentColor" /> : null}
				<ChevronDown className="i sm" />
			</button>
			<Menu anchor={anchor} open={open} onClose={() => setOpen(false)} placement="above-end" width={300}>
				{TASK_SIZES.map((option) => (
					<MenuItem
						key={option.value}
						label={option.label}
						detail={option.description}
						checked={option.value === size}
						onSelect={() => {
							onPick(option.value)
							setOpen(false)
						}}
					/>
				))}
				{size === 'small' ? (
					<>
						<MenuSeparator />
						<MenuItem
							icon={<SkipForward className="i sm" strokeWidth={1.6} fill="currentColor" />}
							label="Auto-advance to pull request"
							detail="Describe the pull request when implementation is done"
							checked={smallAutoAdvance}
							onSelect={() => onSmallAutoAdvance(!smallAutoAdvance)}
						/>
					</>
				) : null}
			</Menu>
		</>
	)
}

function WorkingCopyIcon({ branch }: { branch: boolean }) {
	return branch ? <GitBranch className="i sm" strokeWidth={1.6} /> : <Folder className="i sm" strokeWidth={1.6} />
}
