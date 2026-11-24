import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@devflow/ui/components/select'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { invalidateGithubAccounts, useGithubAccounts } from '@/minimalist/lib/github-accounts'
import { useApi } from '@/orpc/client'

const INHERIT = 'inherit'

/**
 * The project's default GitHub account for your agents: new tasks in it push and open pull requests
 * as this account unless the task picks another. Per person, so each member of a shared project
 * picks from their own accounts. Nothing to choose until you've added an account.
 */
export function ProjectGithubAccountSelect({ projectId, projectName }: { projectId: string; projectName: string }) {
	const { client, queryClient: api } = useApi()
	const queryClient = useQueryClient()
	const { accounts, defaultAccountId, projectDefaults, isReady } = useGithubAccounts()
	const save = useMutation({
		mutationFn: (accountId: string | null) =>
			client.projects.v2.setGithubAccount({ projectId, accountId }, { context: { silent: true } }),
		onSuccess: () => invalidateGithubAccounts(queryClient, api),
		onError: () => toast.error('Could not change the GitHub account. Try again.'),
	})
	const current = projectDefaults[projectId]
	if (!isReady || (accounts.length === 0 && current === undefined)) return null
	const yourDefault = accounts.find((account) => account.id === defaultAccountId)?.login ?? "host's own gh login"
	const id = `project-github-account-${projectId}`
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 py-2">
			<div className="min-w-0">
				<label htmlFor={id} className="text-sm font-medium">
					GitHub account for agents
				</label>
				<div className="text-xs text-muted-foreground">
					New tasks push and open PRs as this account. Each person picks from their own accounts.
				</div>
			</div>
			<Select
				value={current ?? INHERIT}
				disabled={save.isPending}
				onValueChange={(value) => save.mutate(value === INHERIT ? null : value)}
			>
				<SelectTrigger
					id={id}
					aria-label={`GitHub account for ${projectName}`}
					className="w-full shrink-0 sm:w-[240px]"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={INHERIT}>Use my default ({yourDefault})</SelectItem>
					{accounts.map((account) => (
						<SelectItem key={account.id} value={account.id} disabled={account.status === 'needs_token'}>
							{account.status === 'needs_token' ? `${account.login} (needs new token)` : account.login}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}
