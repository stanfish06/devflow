import type { GithubAccount } from '@devflow/api-contract/api/github-accounts/schemas'
import { ORPCError } from '@orpc/client'
import { type QueryClient, useQuery } from '@tanstack/react-query'

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
 * Your GitHub accounts, oldest first, and which one agents use by default. `defaultAccountId` null
 * means each host's own gh login.
 */
export function useGithubAccounts() {
	const { queryClient: api } = useApi()
	const query = useQuery(githubAccountsQuery(api))
	return {
		accounts: query.data?.accounts ?? [],
		defaultAccountId: query.data?.defaultAccountId ?? null,
		isReady: query.isSuccess,
		isError: query.isError,
	}
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
