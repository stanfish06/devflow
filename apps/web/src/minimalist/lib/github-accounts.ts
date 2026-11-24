import type { GithubAccount } from '@devflow/api-contract/api/github-accounts/schemas'
import { ORPCError } from '@orpc/client'
import { and, eq, useLiveQuery } from '@tanstack/react-db'
import { type QueryClient, useQuery } from '@tanstack/react-query'

import { useSync } from '@/components/providers/SyncProvider'
import { useBrowserAuth } from '@/hooks/use-browser-auth'
import { useApi } from '@/orpc/client'

export type { GithubAccount }

type ApiQueries = ReturnType<typeof useApi>['queryClient']

/** The caller's GitHub accounts and their default, from the server (accounts aren't synced). */
export function githubAccountsQuery(api: ApiQueries) {
	return api.githubAccounts.list.queryOptions({ input: {} })
}

/** Refetch the accounts after a change, so every picker sees it. */
export function invalidateGithubAccounts(queryClient: QueryClient, api: ApiQueries): Promise<void> {
	return queryClient.invalidateQueries({ queryKey: api.githubAccounts.list.key() })
}

/**
 * Your GitHub accounts, oldest first, which one agents use by default, and each project's default.
 * `defaultAccountId` null means each host's own gh login.
 */
export function useGithubAccounts() {
	const { queryClient: api } = useApi()
	const query = useQuery(githubAccountsQuery(api))
	return {
		accounts: query.data?.accounts ?? [],
		defaultAccountId: query.data?.defaultAccountId ?? null,
		projectDefaults: query.data?.projectDefaults ?? NO_PROJECT_DEFAULTS,
		isReady: query.isSuccess,
		isError: query.isError,
	}
}

const NO_PROJECT_DEFAULTS: Readonly<Record<string, string>> = {}

/**
 * A pick for a task: one of your accounts by id, or null for each host's own gh login. `undefined`
 * where a level has no pick, so the next level applies.
 */
export type GithubAccountPick = string | null

/** Where the account a task uses comes from: the first level of task → project → your default with a pick. */
export type GithubAccountSource = 'task' | 'project' | 'default' | 'host'

export type ResolvedGithubAccount = {
	/** The account agents push and open pull requests as, or `host` for each host's own gh login. */
	account: GithubAccount | 'host'
	source: GithubAccountSource
}

/**
 * The account a task resolves to, the way the server resolves it for the agent: the task's pick,
 * then the project's default, then yours, then each host's own gh login. A pick naming an account
 * you no longer have is no pick at all (the server clears it when the account is removed).
 */
export function resolveGithubAccount(state: {
	accounts: readonly GithubAccount[]
	task?: GithubAccountPick | undefined
	project?: string | undefined
	defaultAccountId: string | null
}): ResolvedGithubAccount {
	const find = (id: string | null | undefined) => state.accounts.find((account) => account.id === id)
	if (state.task === null) return { account: 'host', source: 'task' }
	const task = find(state.task)
	if (task) return { account: task, source: 'task' }
	const project = find(state.project)
	if (project) return { account: project, source: 'project' }
	const fallback = find(state.defaultAccountId)
	if (fallback) return { account: fallback, source: 'default' }
	return { account: 'host', source: 'host' }
}

/** The account id a resolution names, or null for each host's own gh login. */
export function pickOf(resolved: ResolvedGithubAccount): GithubAccountPick {
	return resolved.account === 'host' ? null : resolved.account.id
}

/** The chip label for a resolution: the login, or the host's own gh login. */
export function githubAccountLabel(resolved: ResolvedGithubAccount): string {
	return resolved.account === 'host' ? 'Host gh login' : resolved.account.login
}

/**
 * Your own pick for one task, from your synced task settings: an account id, null for each host's
 * own gh login, or undefined when you haven't picked (so the project's default and yours apply).
 */
export function useTaskGithubAccountPick(taskId: string | null | undefined): GithubAccountPick | undefined {
	const { taskUserSettingsCollection: settings } = useSync()
	const { user } = useBrowserAuth()
	const userId = user?.id
	const { data } = useLiveQuery(
		(q) =>
			taskId && userId
				? q
						.from({ settings })
						.where(({ settings }) => and(eq(settings.task_id, taskId), eq(settings.user_id, userId)))
				: undefined,
		[settings, taskId, userId],
	)
	const row = data?.[0]
	if (row?.github_use_host_login) return null
	return row?.github_account_id ?? undefined
}

/**
 * The account your agents act as in a task or a project's new tasks, and which level picked it.
 * Without a task, the composer shows what a new task in the project would get.
 */
export function useResolvedGithubAccount({ taskId, projectId }: { taskId?: string | null; projectId?: string | null }) {
	const { accounts, defaultAccountId, projectDefaults, isReady } = useGithubAccounts()
	const task = useTaskGithubAccountPick(taskId)
	const resolved = resolveGithubAccount({
		accounts,
		task,
		project: projectId ? projectDefaults[projectId] : undefined,
		defaultAccountId,
	})
	return { ...resolved, accounts, isReady }
}

/**
 * The server's own words for a failed token check (rejected by GitHub, the wrong account, GitHub
 * unreachable, no key to store it with), or `fallback` for anything else.
 */
export function githubAccountErrorCopy(error: unknown, fallback: string): string {
	if (!(error instanceof ORPCError)) return fallback
	const message = (error.data as { message?: unknown } | undefined)?.message
	const explained = ['BAD_REQUEST', 'GITHUB_UNREACHABLE', 'TOKEN_STORAGE_UNAVAILABLE', 'NOT_FOUND']
	return explained.includes(error.code) && typeof message === 'string' && message.trim() ? message : fallback
}
