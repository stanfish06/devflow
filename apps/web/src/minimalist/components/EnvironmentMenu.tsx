import type { Session } from '@devflow/db/tables/sessions'
import { Copy, FolderGit2, GitBranch, Laptop, Server } from 'lucide-react'
import { useRef, useState } from 'react'

import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/minimalist/components/Menu'
import { type HostView, taskBranch, useHosts, useTask } from '@/minimalist/lib/data'
import { basename, formatAgo, shortPath } from '@/minimalist/lib/format'
import { useCopy } from '@/minimalist/lib/use-copy'

/**
 * Where the session runs, as one quiet chip: host and branch. The directory and
 * its copy action sit behind it, since you only need them when you want the files.
 */
export function EnvironmentMenu({ session, host }: { session: Session; host: HostView | null }) {
	const copy = useCopy()
	const { task } = useTask(session.task_id)
	const branch = taskBranch(task)
	const anchor = useRef<HTMLButtonElement>(null)
	const [open, setOpen] = useState(false)
	// Hosts can load after the thread; until they do, the chip claims neither online nor offline.
	const { isReady: hostsReady } = useHosts()
	const online = host?.online ?? false
	const state = !host && !hostsReady ? 'loading' : online ? 'online' : 'offline'
	const hostName = host?.name ?? (state === 'loading' ? 'Host' : 'Unknown host')
	const HostIcon = host?.host.distribution === 'cli' ? Server : Laptop
	const close = () => setOpen(false)
	return (
		<>
			<button
				type="button"
				ref={anchor}
				className={`env-chip${state === 'offline' ? ' offline' : ''}`}
				aria-label={`Environment: ${hostName}${state === 'loading' ? '' : `, ${state}`}`}
				title={state === 'offline' ? `${hostName} is offline` : session.working_directory}
				onClick={() => setOpen(true)}
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
			</button>
			<Menu anchor={anchor} open={open} onClose={close} placement="below-end" width={320}>
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
		</>
	)
}

function hostStatus(host: HostView | null, loading: boolean): string {
	if (host) return host.online ? 'Online' : `Offline, last seen ${formatAgo(host.lastSeen)}`
	return loading ? 'Checking…' : 'This host is not connected to your account'
}
