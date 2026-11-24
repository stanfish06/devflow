import type { PeriodBucket, PeriodModelCost, PeriodTopTask, PeriodTotals } from '@devflow/api-contract/api/usage/period'
import { type UsagePeriod as Period, periodWindows } from '@devflow/api-contract/api/usage/windows'
import { Link } from '@tanstack/react-router'
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react'

import {
	anchorAbove,
	type TooltipAnchor,
	UsageLegend,
	UsageSwitch,
	UsageTooltip,
} from '@/minimalist/components/UsageParts'
import {
	type ChartSlot,
	chartFamilies,
	chartSlots,
	chartTitle,
	costShare,
	familyColor,
	familyLabel,
	formatAxisCost,
	formatCost,
	formatTokenCount,
	modelColor,
	modelName,
	NO_TOKEN_DATA,
	periodActivities,
	periodActivityDetail,
	periodDelta,
	periodTitle,
	slotAccessibleName,
	slotLabel,
	slotSummary,
	slotTitle,
	tokenBreakdown,
	topWeekdayLabel,
	totalTokens,
	USAGE_PERIOD_OPTIONS,
} from '@/minimalist/lib/usage'
import { useUsagePeriod } from '@/minimalist/lib/use-usage'

const activityCount = new Intl.NumberFormat('en-US')

/**
 * Below the grid: how much you did and spent this week, this month or over the last twelve months,
 * each to date and compared with the same stretch of the period before, then what the money went on:
 * cost by model over the period, by model overall, and the most expensive tasks. The URL owns the
 * period; the selected day never changes it.
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
				<>
					<PeriodTiles period={period} data={totals.data} />
					<CostChart
						period={period}
						today={today}
						buckets={totals.data?.buckets}
						byModel={totals.data?.byModel}
					/>
					<div className="usage-breakdowns">
						<ByModel byModel={totals.data?.byModel} />
						<TopTasks tasks={totals.data?.topTasks} />
					</div>
				</>
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

/**
 * Cost by model over the period: a stacked bar per day (per month for the year), one segment per model
 * family, future slots empty. Hand-built so it matches the page in both themes; one gridline at a clean
 * figure above the tallest bar, the first and last dates under it, and exact figures one hover (or one
 * arrow key) away. The bars keep their slots while a period loads, so switching never collapses it.
 */
function CostChart({
	period,
	today,
	buckets,
	byModel,
}: {
	period: Period
	today: string
	buckets: PeriodBucket[] | undefined
	byModel: PeriodModelCost[] | undefined
}) {
	const frame = useRef<HTMLDivElement>(null)
	const [hover, setHover] = useState<{ index: number; anchor: TooltipAnchor } | null>(null)
	const [focusIndex, setFocusIndex] = useState<number | null>(null)

	const { slots, max } = chartSlots(buckets, periodWindows(period, today).slots, today)
	const title = chartTitle(period)
	const families = chartFamilies(byModel ?? [])
	// Only today and earlier hold anything; the keyboard enters on the latest of them.
	const lastPast = slots.reduce((latest, slot, index) => (slot.future ? latest : index), -1)
	const tabStop = focusIndex !== null && focusIndex <= lastPast ? focusIndex : lastPast
	const hovered = hover ? slots[hover.index] : undefined

	const show = (index: number, target: HTMLElement) => {
		// Point at the top of the bar itself, not the top of the plot.
		const bar = target.querySelector<HTMLElement>('.usage-stack') ?? target
		if (frame.current) setHover({ index, anchor: anchorAbove(bar, frame.current) })
	}
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
		if (step === 0) return
		const next = tabStop + step
		if (next < 0 || next > lastPast) return
		event.preventDefault()
		setFocusIndex(next)
		event.currentTarget.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
	}

	return (
		<section className="usage-chart" aria-label={title} aria-busy={buckets ? undefined : true}>
			<div className="usage-sub-head">
				<h3>{title}</h3>
				{families.length > 0 ? (
					<UsageLegend
						items={families.map((family) => ({
							id: family,
							color: familyColor(family),
							label: familyLabel(family),
						}))}
					/>
				) : null}
			</div>
			<div className="usage-card" ref={frame}>
				<div className="usage-plot">
					<div className="usage-axis" aria-hidden="true">
						{max > 0 ? <span className="top">{formatAxisCost(max)}</span> : null}
						<span className="zero">$0</span>
					</div>
					{max > 0 ? <div className="usage-gridline" aria-hidden="true" /> : null}
					<div
						className="usage-bars"
						role="group"
						aria-label={`${title}, ${slots.length} bars`}
						onKeyDown={onKeyDown}
						onPointerLeave={() => setHover(null)}
					>
						{slots.map((slot, index) => (
							<Bar
								key={slot.start}
								slot={slot}
								max={max}
								index={index}
								period={period}
								hovered={hover?.index === index}
								tabIndex={index === tabStop ? 0 : -1}
								onShow={show}
								onFocusBar={setFocusIndex}
								onHide={() => setHover(null)}
							/>
						))}
					</div>
					{buckets && max === 0 ? <p className="usage-chart-note">No cost recorded this period.</p> : null}
				</div>
				{/* Only the first and last dates, each centred under its bar; the tooltip has the rest. */}
				<div className="usage-xlab" aria-hidden="true">
					{slots.map((slot, index) => (
						<span key={slot.start}>
							{index === 0 || index === slots.length - 1 ? slotLabel(slot.start, period) : null}
						</span>
					))}
				</div>
				{hover && hovered ? (
					<UsageTooltip
						anchor={hover.anchor}
						value={slotSummary(hovered)}
						detail={slotTitle(hovered.start, period)}
						rows={hovered.models.map((entry) => ({
							id: entry.model,
							color: familyColor(entry.family),
							label: modelName(entry.model),
							value: formatCost(entry.costUsd),
						}))}
					/>
				) : null}
			</div>
		</section>
	)
}

/**
 * One slot of the chart: the whole column is the hit target, so a thin or empty bar is as easy to hover
 * as a tall one. A future slot is only space.
 */
function Bar({
	slot,
	max,
	index,
	period,
	hovered,
	tabIndex,
	onShow,
	onFocusBar,
	onHide,
}: {
	slot: ChartSlot
	max: number
	index: number
	period: Period
	hovered: boolean
	tabIndex: number
	onShow: (index: number, target: HTMLElement) => void
	onFocusBar: (index: number) => void
	onHide: () => void
}) {
	const height = max > 0 ? `${(slot.total / max) * 100}%` : '0%'
	if (slot.future)
		return (
			<div className="usage-bar future" aria-hidden="true" onPointerEnter={onHide}>
				<div className="usage-stack" />
			</div>
		)
	return (
		<div
			className={`usage-bar${hovered ? ' on' : ''}`}
			role="img"
			aria-label={slotAccessibleName(slot, period)}
			tabIndex={tabIndex}
			data-index={index}
			onPointerEnter={(event) => onShow(index, event.currentTarget)}
			onFocus={(event) => {
				onFocusBar(index)
				onShow(index, event.currentTarget)
			}}
			onBlur={onHide}
		>
			<div className="usage-stack" style={{ height }}>
				{/* Percentages of the bar, not dollars: flex-grow values summing below 1 would leave it part-filled. */}
				{slot.segments.map((segment) => (
					<i
						key={segment.family}
						style={{
							flexGrow: (segment.costUsd / slot.total) * 100,
							background: familyColor(segment.family),
						}}
					/>
				))}
			</div>
		</div>
	)
}

/** Each model's spend over the period, most expensive first, with its share of the whole as a bar. */
function ByModel({ byModel }: { byModel: PeriodModelCost[] | undefined }) {
	return (
		<section className="usage-models" aria-label="By model">
			<div className="usage-sub-head">
				<h3>By model</h3>
				<span className="hint">cost</span>
			</div>
			<div className="usage-card">
				{byModel === undefined ? (
					<p className="usage-day-note">Loading…</p>
				) : byModel.length === 0 ? (
					<p className="usage-day-note">No cost recorded this period.</p>
				) : (
					<ul className="usage-model-list">
						{byModel.map((row) => (
							<li key={row.model} className="usage-model-row">
								<span className="name">
									<span
										className="sw"
										style={{ background: modelColor(row.model) }}
										aria-hidden="true"
									/>
									<span className="t">{modelName(row.model)}</span>
								</span>
								<span className="share" aria-hidden="true">
									<i
										style={{
											width: `${costShare(row.costUsd, byModel) * 100}%`,
											background: modelColor(row.model),
										}}
									/>
								</span>
								<span className="v">{formatCost(row.costUsd)}</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	)
}

/** The period's most expensive tasks, each linking to its page; archived ones keep their place and say so. */
function TopTasks({ tasks }: { tasks: PeriodTopTask[] | undefined }) {
	return (
		<section className="usage-top" aria-label="Top tasks">
			<div className="usage-sub-head">
				<h3>Top tasks</h3>
				<span className="hint">by cost</span>
			</div>
			<div className="usage-card">
				{tasks === undefined ? (
					<p className="usage-day-note">Loading…</p>
				) : tasks.length === 0 ? (
					<p className="usage-day-note">No task spend recorded this period.</p>
				) : (
					<table className="usage-top-table">
						<thead>
							<tr>
								<th>Task</th>
								<th className="r">Tokens</th>
								<th className="r">Cost</th>
							</tr>
						</thead>
						<tbody>
							{tasks.map((task) => (
								<tr key={task.taskId}>
									<td>
										<span className="t">
											<Link to="/tasks/$taskId" params={{ taskId: task.taskId }}>
												{task.name}
											</Link>
											{task.archived ? <span className="badge">Archived</span> : null}
										</span>
									</td>
									<td className="r num">{formatTokenCount(task.tokens)}</td>
									<td className="r num">{formatCost(task.costUsd)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</section>
	)
}
