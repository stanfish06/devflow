import { useState } from 'react'

import { UsageGrid } from '@/minimalist/components/UsageGrid'
import { localDayKey } from '@/minimalist/lib/usage'
import { useUsageYear } from '@/minimalist/lib/use-usage'

/**
 * Your own activity over the last year. The browser owns "today": it sends its local day and offset,
 * and the server buckets every row into that calendar.
 */
export function UsagePage() {
	const [clock] = useState(() => {
		const now = new Date()
		return { today: localDayKey(now), timezoneOffset: now.getTimezoneOffset() }
	})
	const year = useUsageYear(clock.today, clock.timezoneOffset)

	return (
		<main className="main usage-page">
			<div className="titlebar">
				<span className="title">Usage</span>
			</div>
			<div className="usage-body">
				<div className="usage-content">
					{year.data ? <UsageGrid days={year.data.days} lens="activity" /> : null}
					{!year.data && year.isError ? (
						<div className="usage-card usage-failed" role="alert">
							<span>Couldn't load your usage.</span>
							<button type="button" className="btn sm" onClick={() => void year.refetch()}>
								Try again
							</button>
						</div>
					) : null}
					{!year.data && !year.isError ? <div className="boot-mark" /> : null}
				</div>
			</div>
		</main>
	)
}
