import { useNavigate } from '@tanstack/react-router'
import { House, Settings } from 'lucide-react'
import type { RefObject } from 'react'

import { Avatar } from '@/minimalist/components/Avatar'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/minimalist/components/Menu'
import { type GithubAccount, type GithubAccountPick, useGithubAccounts } from '@/minimalist/lib/github-accounts'

/**
 * The GitHub accounts a task can push and open pull requests as: yours, marked with the project's
 * default and your own, then each host's own gh login. An account whose token GitHub rejected can't
 * be picked until it gets a new one. The composer, the task's environment chip and a session's
 * notice all open this; only what a pick writes differs.
 */
export function GithubAccountMenu({
	anchor,
	open,
	value,
	projectDefaultId,
	hostName,
	onPick,
	onClose,
	placement = 'below-start',
}: {
	anchor: RefObject<HTMLElement | null>
	open: boolean
	/** The account in use now, or null for the host's own gh login. */
	value: GithubAccountPick
	/** The project's default account, when the task is in a project that has one. */
	projectDefaultId?: string | null
	/** The host the task runs on, to say whose gh login the host option means. */
	hostName?: string | null
	onPick: (pick: GithubAccountPick) => void
	onClose: () => void
	placement?: 'above-start' | 'below-start' | 'below-end' | 'above-end'
}) {
	const navigate = useNavigate()
	const { accounts, defaultAccountId } = useGithubAccounts()
	const pick = (next: GithubAccountPick) => {
		onClose()
		onPick(next)
	}
	return (
		<Menu anchor={anchor} open={open} onClose={onClose} placement={placement} width={280}>
			<MenuLabel>Push and open PRs as</MenuLabel>
			{accounts.map((account) => (
				<MenuItem
					key={account.id}
					icon={<Avatar name={account.login} size={18} />}
					label={account.login}
					detail={accountDetail(account, { projectDefaultId, defaultAccountId })}
					checked={value === account.id}
					disabled={account.status === 'needs_token'}
					onSelect={() => pick(account.id)}
				/>
			))}
			{accounts.length > 0 ? <MenuSeparator /> : null}
			<MenuItem
				icon={
					<span className="avatar gh-host" aria-hidden="true" style={{ width: 18, height: 18 }}>
						<House className="i xs" />
					</span>
				}
				label="Host's own gh login"
				detail={[
					hostName ? `Whatever ${hostName} is signed in as` : 'Whatever each host is signed in as',
					defaultAccountId === null && accounts.length > 0 ? 'your default' : null,
				]
					.filter(Boolean)
					.join(' · ')}
				checked={value === null}
				onSelect={() => pick(null)}
			/>
			<MenuSeparator />
			<MenuItem
				icon={<Settings className="i sm" strokeWidth={1.6} />}
				label="Manage GitHub accounts…"
				onSelect={() => {
					onClose()
					void navigate({ to: '/settings/github-accounts' })
				}}
			/>
		</Menu>
	)
}

/** What sets an account apart in the list: a token to replace, or which default it is. */
export function accountDetail(
	account: GithubAccount,
	defaults: { projectDefaultId?: string | null; defaultAccountId: string | null },
): string | undefined {
	if (account.status === 'needs_token') return 'Needs new token'
	const marks = [
		account.id === defaults.projectDefaultId ? 'Project default' : null,
		account.id === defaults.defaultAccountId ? 'Your default' : null,
	].filter(Boolean)
	return marks.length > 0 ? marks.join(' · ') : undefined
}
