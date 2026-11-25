import type { UsagePeriod as Period } from '@devflow/api-contract/api/usage/windows'

import { UsageDayList } from '@/minimalist/components/UsageDayList'
import { UsageGrid } from '@/minimalist/components/UsageGrid'
import { UsagePeriod } from '@/minimalist/components/UsagePeriod'
import { useLocalClock, useUsageYear } from '@/minimalist/lib/use-usage'

/**
 * Your own activity over the last year. The browser owns "today": it sends its local day and offset,
 * and the server buckets every row into that calendar. The URL owns the selected day, whose work is
 * listed under the grid, and the period summarised below it.
 *
 * Left open, the page keeps up: each region refreshes every minute while the tab is visible, and
 * "today" rolls over at local midnight (or when the tab comes back), moving the grid and the period on.
 * A selected day is a date in the URL, so it stays put.
 */
export function UsagePage({
	day,
	onDayChange,
	period,
	onPeriodChange,
}: {
	day: string | null
	onDayChange: (day: string | null) => void
	period: Period
	onPeriodChange: (period: Period) => void
}) {
	const clock = useLocalClock()
	const year = useUsageYear(clock.today, clock.timezoneOffset)

	return (
		<main className="main usage-page">
			<div className="titlebar">
				<span className="title">Usage</span>
			</div>
			<div className="usage-body">
				<div className="usage-content">
					{year.data ? <UsageGrid days={year.data.days} selectedDay={day} onSelectDay={onDayChange} /> : null}
					{!year.data && year.isError ? (
						<div className="usage-card usage-failed" role="alert">
							<span>Couldn't load your usage.</span>
							<button type="button" className="btn sm" onClick={() => void year.refetch()}>
								Try again
							</button>
						</div>
					) : null}
					{!year.data && !year.isError ? <div className="boot-mark" /> : null}
					{day ? (
						<UsageDayList
							date={day}
							timezoneOffset={clock.timezoneOffset}
							onClear={() => onDayChange(null)}
						/>
					) : null}
					<UsagePeriod
						period={period}
						onPeriodChange={onPeriodChange}
						today={clock.today}
						timezoneOffset={clock.timezoneOffset}
					/>
				</div>
			</div>
		</main>
	)
}
