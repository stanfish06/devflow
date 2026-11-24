import { useQuery } from '@tanstack/react-query'

import { useApi } from '@/orpc/client'

/**
 * The caller's year grid. The key carries the signed-in user and organization, so one browser cache
 * never shows one account's history to another (the server reads both from the token regardless), and
 * every visit refetches so the page is current when you open it.
 */
export function useUsageYear(today: string, timezoneOffset: number) {
	const { queryClient: api, authScope } = useApi()
	const options = api.usage.year.queryOptions({ input: { today, timezoneOffset } })
	return useQuery({
		...options,
		queryKey: [...options.queryKey, authScope],
		enabled: authScope.userId !== null && authScope.organizationId !== null,
		refetchOnMount: 'always',
	})
}
