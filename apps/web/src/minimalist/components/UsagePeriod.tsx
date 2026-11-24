import type { PeriodTotals } from '@devflow/api-contract/api/usage/period'
import type { UsagePeriod as Period } from '@devflow/api-contract/api/usage/windows'
import type { ReactNode } from 'react'

import { UsageSwitch } from '@/minimalist/components/UsageParts'
import {
	formatCost,
	formatTokenCount,
	NO_TOKEN_DATA,
	periodActivities,
	periodActivityDetail,
	periodDelta,
	periodTitle,
	tokenBreakdown,
	topWeekdayLabel,
	totalTokens,
	USAGE_PERIOD_OPTIONS,
} from '@/minimalist/lib/usage'
import { useUsagePeriod } from '@/minimalist/lib/use-usage'

const activityCount = new Intl.NumberFormat('en-US')

/**
 * Below the grid: how much you did and spent this week, this month or over the last twelve months,
 * each to date and compared with the same stretch of the period before. The URL owns the period; the
 * selected day never changes it.
 */
export function UsagePeriod({
	period,
	onPeriodChange,
	today,
	timezoneOffset,
}: {
	period: Period
	onPeriodChange: (period: Period) => void
	today: string
	timezoneOffset: number
}) {
	const totals = useUsagePeriod(period, today, timezoneOffset)
	const title = periodTitle(period)

	return (
		<section className="usage-period" aria-label={title}>
			<div className="usage-period-head">
				<h2>{title}</h2>
				<UsageSwitch label="Period" value={period} options={USAGE_PERIOD_OPTIONS} onChange={onPeriodChange} />
			</div>
			{!totals.data && totals.isError ? (
				<div className="usage-card usage-failed" role="alert">
					<span>Couldn't load this period.</span>
					<button type="button" className="btn sm" onClick={() => void totals.refetch()}>
						Try again
					</button>
				</div>
			) : (
				<PeriodTiles period={period} data={totals.data} />
			)}
			<p className="usage-footnote">
				Tokens and cost cover Claude sessions only. Codex sessions count toward activity.
			</p>
		</section>
	)
}

/** Four tiles that keep their place while loading, so the page doesn't jump when a period arrives. */
function PeriodTiles({
	period,
	data,
}: {
	period: Period
	data: { current: PeriodTotals; previous: PeriodTotals } | undefined
}) {
	if (!data)
		return (
			<div className="usage-tiles" aria-busy="true">
				{['Activities', 'Tokens', 'Cost', 'Active days'].map((label) => (
					<Tile key={label} label={label} value={<span className="usage-tile-skel" />} />
				))}
			</div>
		)

	const { current, previous } = data
	const tokens = current.tokens === null ? null : totalTokens(current.tokens)
	const previousTokens = previous.tokens === null ? null : totalTokens(previous.tokens)
	return (
		<div className="usage-tiles">
			<Tile
				label="Activities"
				value={activityCount.format(periodActivities(current))}
				details={[periodActivityDetail(current)]}
			/>
			<Tile
				label="Tokens"
				value={tokens === null ? <NoData /> : formatTokenCount(tokens)}
				details={
					current.tokens === null
						? [NO_TOKEN_DATA]
						: [periodDelta(tokens, previousTokens, period), tokenBreakdown(current.tokens)]
				}
			/>
			<Tile
				label="Cost"
				value={current.costUsd === null ? <NoData /> : formatCost(current.costUsd)}
				details={
					current.costUsd === null
						? [NO_TOKEN_DATA]
						: [periodDelta(current.costUsd, previous.costUsd, period)]
				}
			/>
			<Tile
				label="Active days"
				value={
					<>
						{activityCount.format(current.activeDays)}
						<span className="of"> / {activityCount.format(current.elapsedDays)}</span>
					</>
				}
				details={[topWeekdayLabel(current.topWeekday)]}
			/>
		</div>
	)
}

function Tile({ label, value, details = [] }: { label: string; value: ReactNode; details?: Array<string | null> }) {
	return (
		<div className="usage-tile" role="group" aria-label={label}>
			<div className="k">{label}</div>
			<div className="v">{value}</div>
			{details.map((detail) =>
				detail ? (
					<div key={detail} className="d">
						{detail}
					</div>
				) : null,
			)}
		</div>
	)
}

/** A missing figure: a dash, never $0.00, with the reason for screen readers in the line below. */
function NoData() {
	return (
		<span className="none" aria-hidden="true">
			—
		</span>
	)
}
