import { ChevronDown, Layers } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'

import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/minimalist/components/Menu'
import { UsageBars, usageSummary } from '@/minimalist/components/UsageBars'
import { useHosts } from '@/minimalist/lib/data'
import { formatAgo } from '@/minimalist/lib/format'
import { useWorkingHost, type WorkingHost } from '@/minimalist/lib/use-working-host'

/** A host that is gone keeps its place by id; a short id is all that is left to name it. */
export function removedHostLabel(id: string): string {
	return `${id.slice(0, 8)} (removed)`
}

/** What the switcher button says: the host's name, "All hosts", or what is left of a removed host. */
function switcherLabel(working: ReturnType<typeof useWorkingHost>): string {
	if (!working.isReady) return 'Loading hosts…'
	switch (working.state) {
		case 'all':
			return 'All hosts'
		case 'missing':
			return removedHostLabel(working.id)
		default:
			return working.host?.name ?? working.id
	}
}

/**
 * The working host, under the brand row: the one choice that masks the sidebar and seeds new
 * tasks. Its menu is also where every host's status and usage live, so you compare them as you pick.
 */
export function WorkingHostSwitcher() {
	const working = useWorkingHost()
	const { hosts, isReady } = useHosts()
	const anchor = useRef<HTMLButtonElement>(null)
	const [open, setOpen] = useState(false)
	const pick = (choice: WorkingHost) => {
		working.set(choice)
		setOpen(false)
	}
	const label = switcherLabel(working)
	return (
		<>
			<button
				type="button"
				ref={anchor}
				className="host-switch"
				aria-label={`Working host: ${label}${working.state === 'offline' && working.isReady ? ', offline' : ''}`}
				title="Working host: masks the sidebar and is where new tasks start"
				onClick={() => setOpen(true)}
			>
				{working.state === 'all' ? (
					<Layers className="i sm" strokeWidth={1.6} />
				) : (
					<span className={`dot ${working.state === 'online' ? 'ok' : 'off'}`} />
				)}
				<span className="name ell">{label}</span>
				{working.isReady && working.state === 'offline' ? <span className="state">offline</span> : null}
				<ChevronDown className="i sm chev" />
			</button>
			<Menu anchor={anchor} open={open} onClose={() => setOpen(false)} placement="below-start" width={280}>
				<MenuLabel>Working host</MenuLabel>
				<MenuItem
					icon={<Layers className="i sm" strokeWidth={1.6} />}
					label="All hosts"
					detail="Show every project"
					checked={working.id === 'all'}
					onSelect={() => pick('all')}
				/>
				<MenuSeparator />
				{isReady && hosts.length === 0 ? (
					<div className="empty">No hosts yet. Start a daemon to add one.</div>
				) : null}
				{hosts.map((entry) => {
					const selected = working.id === entry.host.host_id
					const limits = entry.host.coding_agent_usage_limits?.claude
					return (
						<Fragment key={entry.host.host_id}>
							<MenuItem
								icon={<span className={`dot ${entry.online ? 'ok' : 'off'}`} />}
								label={entry.name}
								detail={
									entry.online
										? (usageSummary(limits) ?? 'Online')
										: `last seen ${formatAgo(entry.lastSeen)}`
								}
								checked={selected}
								onSelect={() => pick(entry.host.host_id)}
							/>
							{selected ? <UsageBars limits={limits} /> : null}
						</Fragment>
					)
				})}
				{working.isReady && working.state === 'missing' ? (
					<MenuItem
						icon={<span className="dot off" />}
						label={removedHostLabel(working.id)}
						detail="This host was removed. Pick another one."
						checked
						disabled
					/>
				) : null}
			</Menu>
		</>
	)
}
