import type { Session } from '@devflow/db/tables/sessions'
import { Copy, FolderGit2, GitBranch, House, Laptop, Server } from 'lucide-react'
import { useRef, useState } from 'react'

import { useBrowserAuth } from '@/hooks/use-browser-auth'
import { Avatar } from '@/minimalist/components/Avatar'
import { GithubAccountMenu } from '@/minimalist/components/GithubAccountMenu'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/minimalist/components/Menu'
import { type HostView, taskBranch, useHosts, useTask } from '@/minimalist/lib/data'
import { basename, formatAgo, shortPath } from '@/minimalist/lib/format'
import {
	type GithubAccountPick,
	githubAccountLabel,
	pickOf,
	type ResolvedGithubAccount,
	useGithubAccounts,
	useResolvedGithubAccount,
} from '@/minimalist/lib/github-accounts'
import { useUi } from '@/minimalist/lib/ui-state'
import { useAction } from '@/minimalist/lib/use-action'
import { useCopy } from '@/minimalist/lib/use-copy'
import { useApi } from '@/orpc/client'

/**
 * Where the session runs, as one quiet chip: host, branch and, in your own sessions, the GitHub
 * account it pushes as. The directory and its copy action sit behind it, since you only need them
 * when you want the files; the account opens the same menu the composer uses.
 */
export function EnvironmentMenu({ session, host }: { session: Session; host: HostView | null }) {
	const copy = useCopy()
	const { task } = useTask(session.task_id)
	const branch = taskBranch(task)
	const anchor = useRef<HTMLButtonElement>(null)
	const [open, setOpen] = useState<'environment' | 'account' | null>(null)
	// Hosts can load after the thread; until they do, the chip claims neither online nor offline.
	const { isReady: hostsReady } = useHosts()
	const online = host?.online ?? false
	const state = !host && !hostsReady ? 'loading' : online ? 'online' : 'offline'
	const hostName = host?.name ?? (state === 'loading' ? 'Host' : 'Unknown host')
	const HostIcon = host?.host.distribution === 'cli' ? Server : Laptop
	const account = useTaskAccount(session, task?.project_id ?? null)
	const close = () => setOpen(null)
	return (
		<>
			<button
				type="button"
				ref={anchor}
				className={`env-chip${state === 'offline' ? ' offline' : ''}`}
				aria-label={`Environment: ${hostName}${state === 'loading' ? '' : `, ${state}`}${
					account.shown ? `, pushes as ${githubAccountLabel(account.resolved)}` : ''
				}`}
				title={state === 'offline' ? `${hostName} is offline` : session.working_directory}
				onClick={() => setOpen('environment')}
			>
				<span className="env-host">
					<HostIcon className="i sm" strokeWidth={1.6} />
					{state === 'loading' ? null : <span className={`dot ${online ? 'on' : 'off'}`} />}
				</span>
				<span className="label host-name">{hostName}</span>
				<span className="label host-name dim">·</span>
				{branch ? (
					<GitBranch className="i sm label" strokeWidth={1.6} />
				) : (
					<FolderGit2 className="i sm label" strokeWidth={1.6} />
				)}
				<span className="label mono">{branch ?? basename(session.working_directory)}</span>
				{account.shown ? (
					<>
						<span className="label dim">·</span>
						<span className="label">{githubAccountLabel(account.resolved)}</span>
					</>
				) : null}
			</button>
			<Menu anchor={anchor} open={open === 'environment'} onClose={close} placement="below-end" width={320}>
				<MenuLabel>Runs on</MenuLabel>
				<div className="env-row">
					<HostIcon className="i sm" strokeWidth={1.6} />
					<div>
						<div>{hostName}</div>
						<div className="d">{hostStatus(host, state === 'loading')}</div>
					</div>
				</div>
				{branch ? (
					<div className="env-row">
						<GitBranch className="i sm" strokeWidth={1.6} />
						<div className="mono ell">{branch}</div>
					</div>
				) : null}
				<div className="env-row">
					<FolderGit2 className="i sm" strokeWidth={1.6} />
					<div className="lines">
						<div className="ell">{basename(session.working_directory)}</div>
						<div className="d mono" title={session.working_directory}>
							{shortPath(session.working_directory, 44)}
						</div>
					</div>
				</div>
				{account.shown ? (
					<>
						<MenuLabel>Pushes and opens PRs as</MenuLabel>
						<MenuItem
							icon={
								account.resolved.account === 'host' ? (
									<House className="i sm" strokeWidth={1.6} />
								) : (
									<Avatar name={account.resolved.account.login} size={18} />
								)
							}
							label={githubAccountLabel(account.resolved)}
							detail={`${sourceCopy(account.resolved)} · Change…`}
							disabled={account.pending}
							onSelect={() => setOpen('account')}
						/>
					</>
				) : null}
				<MenuSeparator />
				<MenuItem
					icon={<Copy className="i sm" strokeWidth={1.6} />}
					label="Copy path"
					onSelect={() => {
						close()
						copy(
							session.working_directory,
							'Path copied',
							'Could not copy the path. Select it in this menu and copy it by hand.',
						)
					}}
				/>
			</Menu>
			{account.shown ? (
				<GithubAccountMenu
					anchor={anchor}
					open={open === 'account'}
					onClose={close}
					placement="below-end"
					value={pickOf(account.resolved)}
					projectDefaultId={account.projectDefaultId}
					hostName={host?.name}
					onPick={account.pick}
				/>
			) : null}
		</>
	)
}

/**
 * The account your own sessions in this task push as, and a way to change it for the task. A
 * teammate's session follows their own choices, which aren't yours to show or change, and a
 * session outside a task has no task to pick for. Without any accounts there is nothing to show.
 */
function useTaskAccount(session: Session, projectId: string | null) {
	const { user } = useBrowserAuth()
	const { client: api } = useApi()
	const { showToast } = useUi()
	const action = useAction()
	const { projectDefaults } = useGithubAccounts()
	const resolved = useResolvedGithubAccount({ taskId: session.task_id, projectId })
	const mine = Boolean(user?.id) && session.created_by === user?.id && session.task_id !== null
	const shown = mine && resolved.isReady && (resolved.accounts.length > 0 || resolved.source === 'task')
	const pick = (next: GithubAccountPick) => {
		const taskId = session.task_id
		// Picking the account the task already inherits still pins it, so later default changes pass it by.
		if (!taskId || (resolved.source === 'task' && next === pickOf(resolved))) return
		const login = resolved.accounts.find((account) => account.id === next)?.login
		void action
			.run(
				() => api.tasks.setGithubAccount({ taskId, accountId: next }, { context: { silent: true } }),
				'Could not change the GitHub account. Try again.',
			)
			.then((saved) => {
				if (saved)
					showToast(
						login ? `This task now pushes as ${login}` : "This task now pushes as each host's own gh login",
					)
			})
	}
	return {
		shown,
		resolved,
		pending: action.pending,
		projectDefaultId: projectId ? projectDefaults[projectId] : undefined,
		pick,
	}
}

function sourceCopy(resolved: ResolvedGithubAccount): string {
	switch (resolved.source) {
		case 'task':
			return 'Picked for this task'
		case 'project':
			return "The project's default"
		case 'default':
			return 'Your default'
		case 'host':
			return "Whatever this host's gh is signed in as"
	}
}

function hostStatus(host: HostView | null, loading: boolean): string {
	if (host) return host.online ? 'Online' : `Offline, last seen ${formatAgo(host.lastSeen)}`
	return loading ? 'Checking…' : 'This host is not connected to your account'
}
