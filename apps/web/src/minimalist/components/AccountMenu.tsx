import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Activity, Archive, Building2, LogOut, Settings } from 'lucide-react'
import { useRef, useState } from 'react'

import { useBrowserAuth as useAuth } from '@/hooks/use-browser-auth'
import { WiredUserAvatar } from '@/minimalist/components/Avatar'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/minimalist/components/Menu'
import { shortcutHint } from '@/minimalist/lib/shortcuts'
import { useUi } from '@/minimalist/lib/ui-state'
import { useApi } from '@/orpc/client'

/**
 * The sidebar's footer: only who you are. Host status and usage live in the working-host switcher,
 * so this menu is about your account: settings, archived work, organizations and sign out.
 */
export function AccountMenu() {
	const { user, signOut, organizationId, switchOrganization } = useAuth()
	const { queryClient: orpc } = useApi()
	const organizations =
		useQuery({ ...orpc.auth.user.organizations.list.queryOptions(), staleTime: 60_000 }).data?.organizations ?? []
	const { showToast } = useUi()
	const navigate = useNavigate()
	const anchor = useRef<HTMLButtonElement>(null)
	const [open, setOpen] = useState(false)
	const go = (to: '/usage' | '/settings/general' | '/settings/archived') => {
		setOpen(false)
		void navigate({ to })
	}
	return (
		<>
			<button type="button" ref={anchor} className="me" onClick={() => setOpen(true)}>
				{user ? <WiredUserAvatar userId={user.id} /> : null}
				<span className="ell">{user?.firstName ?? user?.email}</span>
			</button>
			<Menu anchor={anchor} open={open} onClose={() => setOpen(false)} placement="above-start" width={260}>
				{/* Live usage per host is in the working-host switcher; this is how you've used it over time. */}
				<MenuItem
					icon={<Activity className="i sm" strokeWidth={1.6} />}
					label="Usage history"
					onSelect={() => go('/usage')}
				/>
				<MenuSeparator />
				<MenuItem
					icon={<Settings className="i sm" strokeWidth={1.6} />}
					label="Settings"
					kbd={shortcutHint('settings')}
					onSelect={() => go('/settings/general')}
				/>
				<MenuItem
					icon={<Archive className="i sm" strokeWidth={1.6} />}
					label="Archived"
					onSelect={() => go('/settings/archived')}
				/>
				{organizations.length > 1 ? (
					<>
						<MenuSeparator />
						<MenuLabel>Organizations</MenuLabel>
						{organizations.map((org) => (
							<MenuItem
								key={org.organizationId}
								icon={<Building2 className="i sm" strokeWidth={1.6} />}
								label={org.organizationName}
								checked={org.organizationId === organizationId}
								onSelect={() => {
									setOpen(false)
									if (org.organizationId === organizationId) return
									switchOrganization({ organizationId: org.organizationId }).catch(() =>
										showToast(`Could not switch to ${org.organizationName}. Try again.`),
									)
								}}
							/>
						))}
					</>
				) : null}
				<MenuSeparator />
				<MenuItem
					icon={<LogOut className="i sm" strokeWidth={1.6} />}
					label="Sign out"
					onSelect={() => signOut({ returnTo: window.location.origin })}
				/>
			</Menu>
		</>
	)
}
