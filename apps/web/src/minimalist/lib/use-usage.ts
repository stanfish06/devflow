import type { UsagePeriod } from '@devflow/api-contract/api/usage/windows'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useMountEffect } from '@/hooks/useMountEffect'
import { type LocalClock, msUntilLocalMidnight, readLocalClock, sameLocalClock } from '@/minimalist/lib/usage'
import { useApi } from '@/orpc/client'

/**
 * How every usage region stays current: refetched on each visit, then once a minute while the tab is
 * visible. A hidden tab stops polling and catches up when it comes back, so an idle page costs nothing.
 */
const LIVE_USAGE = {
	refetchOnMount: 'always',
	refetchInterval: 60_000,
	refetchIntervalInBackground: false,
} as const

/**
 * The caller's year grid. The key carries the signed-in user and organization, so one browser cache
 * never shows one account's history to another (the server reads both from the token regardless), and
 * the region refreshes as {@link LIVE_USAGE} describes.
 */
export function useUsageYear(today: string, timezoneOffset: number) {
	const { queryClient: api, authScope } = useApi()
	const options = api.usage.year.queryOptions({ input: { today, timezoneOffset } })
	return useQuery({
		...options,
		...LIVE_USAGE,
		queryKey: [...options.queryKey, authScope],
		enabled: authScope.userId !== null && authScope.organizationId !== null,
	})
}

/**
 * What the caller worked on during one local day. Mounted only while the day list is open, so closing
 * the list drops the subscription and its refresh; scoped and refreshed like {@link useUsageYear}.
 */
export function useUsageDay(date: string, timezoneOffset: number) {
	const { queryClient: api, authScope } = useApi()
	const options = api.usage.day.queryOptions({ input: { date, timezoneOffset } })
	return useQuery({
		...options,
		...LIVE_USAGE,
		queryKey: [...options.queryKey, authScope],
		enabled: authScope.userId !== null && authScope.organizationId !== null,
	})
}

/**
 * The caller's totals for a calendar period to date and the same stretch of the one before. Switching
 * period fetches only this; scoped and refreshed like {@link useUsageYear}.
 */
export function useUsagePeriod(period: UsagePeriod, today: string, timezoneOffset: number) {
	const { queryClient: api, authScope } = useApi()
	const options = api.usage.period.queryOptions({ input: { period, today, timezoneOffset } })
	return useQuery({
		...options,
		...LIVE_USAGE,
		queryKey: [...options.queryKey, authScope],
		enabled: authScope.userId !== null && authScope.organizationId !== null,
	})
}

/**
 * The browser's "today" and offset, kept current while the page stays open: re-read at each local
 * midnight and whenever the tab becomes visible again (a hidden tab's timers can run late, and the
 * laptop may have slept or crossed a time zone). A re-read that changes nothing keeps the old value, so
 * the queries keyed on it don't refetch for nothing.
 */
export function useLocalClock(): LocalClock {
	const [clock, setClock] = useState(() => readLocalClock(new Date()))

	useMountEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const reread = () => {
			const now = new Date()
			const next = readLocalClock(now)
			setClock((current) => (sameLocalClock(current, next) ? current : next))
			clearTimeout(timer)
			// A moment past midnight, so the new day has certainly begun when the timer fires.
			timer = setTimeout(reread, msUntilLocalMidnight(now) + 1_000)
		}
		const onVisibility = () => {
			if (document.visibilityState === 'visible') reread()
		}
		reread()
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			clearTimeout(timer)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	})

	return clock
}
