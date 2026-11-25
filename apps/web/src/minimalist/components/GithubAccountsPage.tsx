import { useQueryClient } from '@tanstack/react-query'
import { House } from 'lucide-react'
import { useState } from 'react'

import { Avatar } from '@/minimalist/components/Avatar'
import { Dialog } from '@/minimalist/components/Dialog'
import { SettingsGroup } from '@/minimalist/components/SettingsControls'
import { TextDialog } from '@/minimalist/components/TextDialog'
import { formatAgo } from '@/minimalist/lib/format'
import {
	type GithubAccount,
	githubAccountErrorCopy,
	invalidateGithubAccounts,
	useGithubAccounts,
} from '@/minimalist/lib/github-accounts'
import { useUi } from '@/minimalist/lib/ui-state'
import { useAction } from '@/minimalist/lib/use-action'
import { useApi } from '@/orpc/client'

const TOKEN_HINT =
	'Paste a personal access token. It needs read and write access to contents and pull requests on the repositories your agents work in.'

type Editing =
	| { kind: 'add' }
	| { kind: 'replace'; account: GithubAccount }
	| { kind: 'remove'; account: GithubAccount }

/**
 * Settings → GitHub accounts: the accounts your agents can push and open pull requests as, on any of
 * your hosts. Tokens go to the server once and never come back; rows show only who they belong to.
 */
export function GithubAccountsPage() {
	const { accounts, defaultAccountId, isReady, isError } = useGithubAccounts()
	const { client: api, queryClient: orpc } = useApi()
	const queryClient = useQueryClient()
	const { showToast } = useUi()
	const action = useAction()
	const [editing, setEditing] = useState<Editing | null>(null)
	const refresh = () => invalidateGithubAccounts(queryClient, orpc)

	const makeDefault = (account: GithubAccount | null) =>
		void action.run(async () => {
			await api.githubAccounts.setDefault({ accountId: account?.id ?? null }, { context: { silent: true } })
			await refresh()
			showToast(account ? `${account.login} is now your default` : "Agents now use each host's own gh login")
		}, 'Could not change your default account. Try again.')

	return (
		<>
			<p className="settings-lede">
				Accounts your agents can push and open pull requests as, on any of your hosts. Tokens are stored by
				devflow and never shown again after you save them.
			</p>
			{isError ? (
				<p className="settings-lede" role="alert">
					Could not load your GitHub accounts. Reload the page to try again.
				</p>
			) : isReady ? (
				<SettingsGroup
					title="Your accounts"
					action={
						<button type="button" className="btn sm" onClick={() => setEditing({ kind: 'add' })}>
							Add account…
						</button>
					}
				>
					{accounts.map((account) => (
						<AccountRow
							key={account.id}
							account={account}
							isDefault={account.id === defaultAccountId}
							busy={action.pending}
							onMakeDefault={() => makeDefault(account)}
							onReplace={() => setEditing({ kind: 'replace', account })}
							onRemove={() => setEditing({ kind: 'remove', account })}
						/>
					))}
					<div className="srow">
						<span className="avatar gh-host" aria-hidden="true">
							<House className="i xs" />
						</span>
						<div className="l">
							<b>Host's own gh login</b>
							<span>Whatever account each host is signed in to with gh</span>
						</div>
						{defaultAccountId === null ? (
							<span className="badge">Default</span>
						) : (
							<button
								type="button"
								className="btn"
								disabled={action.pending}
								onClick={() => makeDefault(null)}
							>
								Make default
							</button>
						)}
					</div>
				</SettingsGroup>
			) : null}
			{editing?.kind === 'add' ? (
				<TextDialog
					title="Add GitHub account"
					description={TOKEN_HINT}
					initialValue=""
					placeholder="github_pat_…"
					submitLabel="Add account"
					secret
					failure={(error) => githubAccountErrorCopy(error, 'Could not add the account. Try again.')}
					onSave={async (token) => {
						const { account } = await api.githubAccounts.add({ token }, { context: { silent: true } })
						await refresh()
						showToast(`Added ${account.login}`)
					}}
					onClose={() => setEditing(null)}
				/>
			) : null}
			{editing?.kind === 'replace' ? (
				<TextDialog
					title={`Replace ${editing.account.login}'s token`}
					description={`${TOKEN_HINT} It must belong to ${editing.account.login}.`}
					initialValue=""
					placeholder="github_pat_…"
					submitLabel="Replace token"
					secret
					failure={(error) => githubAccountErrorCopy(error, 'Could not replace the token. Try again.')}
					onSave={async (token) => {
						await api.githubAccounts.replaceToken(
							{ accountId: editing.account.id, token },
							{ context: { silent: true } },
						)
						await refresh()
						showToast(`Replaced ${editing.account.login}'s token`)
					}}
					onClose={() => setEditing(null)}
				/>
			) : null}
			{editing?.kind === 'remove' ? (
				<RemoveAccountDialog
					account={editing.account}
					isDefault={editing.account.id === defaultAccountId}
					onRemoved={refresh}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</>
	)
}

function AccountRow({
	account,
	isDefault,
	busy,
	onMakeDefault,
	onReplace,
	onRemove,
}: {
	account: GithubAccount
	isDefault: boolean
	busy: boolean
	onMakeDefault: () => void
	onReplace: () => void
	onRemove: () => void
}) {
	const needsToken = account.status === 'needs_token'
	return (
		<div className="srow">
			<Avatar name={account.login} size={24} />
			<div className="l">
				<b>{account.login}</b>
				<span>
					{account.noreplyEmail} · Added {formatAgo(account.createdAt)}
				</span>
			</div>
			{needsToken ? <span className="badge warn">Needs new token</span> : null}
			{isDefault ? (
				<span className="badge">Default</span>
			) : (
				<button
					type="button"
					className="btn"
					disabled={busy || needsToken}
					title={needsToken ? 'Replace its token first' : undefined}
					onClick={onMakeDefault}
				>
					Make default
				</button>
			)}
			<button type="button" className="btn" onClick={onReplace}>
				Replace token
			</button>
			<button type="button" className="btn ghost-danger" onClick={onRemove}>
				Remove
			</button>
		</div>
	)
}

/** Removing deletes the stored token; anything that picked the account falls back to the next choice. */
function RemoveAccountDialog({
	account,
	isDefault,
	onRemoved,
	onClose,
}: {
	account: GithubAccount
	isDefault: boolean
	onRemoved: () => Promise<void>
	onClose: () => void
}) {
	const { client: api } = useApi()
	const { showToast } = useUi()
	const action = useAction('inline')
	const remove = () =>
		void action
			.run(async () => {
				await api.githubAccounts.remove({ accountId: account.id }, { context: { silent: true } })
				await onRemoved()
				showToast(`Removed ${account.login}`)
			}, `Could not remove ${account.login}. Try again.`)
			.then((removed) => {
				if (removed) onClose()
			})
	return (
		<Dialog
			title={`Remove ${account.login}?`}
			description={
				isDefault
					? "devflow deletes its stored token. It's your default, so agents go back to each host's own gh login."
					: 'devflow deletes its stored token. Nothing on GitHub changes.'
			}
			busy={action.pending}
			error={action.error}
			onClose={onClose}
			onSubmit={remove}
		>
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={onClose} disabled={action.pending}>
					Cancel
				</button>
				<button type="submit" className="btn danger" disabled={action.pending}>
					{action.pending ? 'Removing…' : 'Remove'}
				</button>
			</div>
		</Dialog>
	)
}
