import { type UsageDayRow, usageDayRowActivity } from '@devflow/api-contract/api/usage/day'
import { Link } from '@tanstack/react-router'
import { X } from 'lucide-react'

import {
	dayListCount,
	dayRowMeta,
	formatCost,
	formatDayLong,
	formatTokenCount,
	NO_TOKEN_DATA,
} from '@/minimalist/lib/usage'
import { useUsageDay } from '@/minimalist/lib/use-usage'

const activityCount = new Intl.NumberFormat('en-US')

/**
 * What you worked on during the selected day, under the grid: one row per task, and one per session
 * with no task, busiest first. The card is height-limited and scrolls on a busy day, so the rest of the
 * page never moves down. Closing it (Clear, or clicking the selected cell again) clears the day.
 */
export function UsageDayList({
	date,
	timezoneOffset,
	onClear,
}: {
	date: string
	timezoneOffset: number
	onClear: () => void
}) {
	const day = useUsageDay(date, timezoneOffset)
	const title = formatDayLong(date)
	const count = day.data ? dayListCount(day.data.rows) : null

	return (
		<section className="usage-day" aria-label={`Work on ${title}`}>
			<div className="usage-day-head">
				<h2>
					{title}
					{count ? <span className="usage-day-count"> · {count}</span> : null}
				</h2>
				<button type="button" className="btn ghost sm" onClick={onClear}>
					Clear
					<X className="i xs" aria-hidden="true" />
				</button>
			</div>
			<div className="usage-card">
				{day.data ? (
					day.data.rows.length > 0 ? (
						<DayTable rows={day.data.rows} title={title} />
					) : (
						<p className="usage-day-note">No activity on this day.</p>
					)
				) : day.isError ? (
					<div className="usage-failed" role="alert">
						<span>Couldn't load this day.</span>
						<button type="button" className="btn sm" onClick={() => void day.refetch()}>
							Try again
						</button>
					</div>
				) : (
					<p className="usage-day-note">Loading…</p>
				)}
			</div>
		</section>
	)
}

function DayTable({ rows, title }: { rows: UsageDayRow[]; title: string }) {
	return (
		<div role="table" aria-label={`Tasks on ${title}`}>
			<div role="rowgroup">
				<div role="row" className="usage-day-row th">
					<span role="columnheader">Task</span>
					<span role="columnheader" className="r">
						Activity
					</span>
					<span role="columnheader" className="r">
						Tokens
					</span>
					<span role="columnheader" className="r">
						Cost
					</span>
				</div>
			</div>
			<div role="rowgroup" className="usage-day-scroll">
				{rows.map((row) => (
					<DayRow key={`${row.kind}:${row.id}`} row={row} />
				))}
			</div>
		</div>
	)
}

function DayRow({ row }: { row: UsageDayRow }) {
	return (
		<div role="row" className="usage-day-row">
			<span role="cell" className="usage-day-name">
				<span className="t">
					{row.kind === 'task' ? (
						<Link to="/tasks/$taskId" params={{ taskId: row.id }}>
							{row.name}
						</Link>
					) : (
						<Link to="/sessions/$sessionId" params={{ sessionId: row.id }}>
							{row.name}
						</Link>
					)}
					{row.archived ? <span className="badge">Archived</span> : null}
				</span>
				<span className="meta">{dayRowMeta(row)}</span>
			</span>
			<span role="cell" className="r num">
				{activityCount.format(usageDayRowActivity(row))}
			</span>
			<UsageCell value={row.tokens === null ? null : formatTokenCount(row.tokens)} />
			<UsageCell value={row.costUsd === null ? null : formatCost(row.costUsd)} />
		</div>
	)
}

/** A token or cost figure; a dash when the row has no ledger rows, which never reads as free. */
function UsageCell({ value }: { value: string | null }) {
	if (value === null)
		return (
			<span role="cell" className="r num none" title={NO_TOKEN_DATA}>
				<span aria-hidden="true">—</span>
				<span className="sr-only">{NO_TOKEN_DATA}</span>
			</span>
		)
	return (
		<span role="cell" className="r num">
			{value}
		</span>
	)
}
