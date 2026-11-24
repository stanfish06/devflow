import type { DayUsage } from '@devflow/api-contract/api/usage/year'
import { Link } from '@tanstack/react-router'
import { type KeyboardEvent, useRef, useState } from 'react'

import { anchorAbove, type TooltipAnchor, UsageLegend, UsageTooltip } from '@/minimalist/components/UsageParts'
import {
	cellLabel,
	cellSummary,
	formatDayLong,
	gridLayout,
	headline,
	intensityLevel,
	intensityThresholds,
	lensValue,
	streaks,
	type UsageLens,
} from '@/minimalist/lib/usage'

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''] as const
const LEVELS = [0, 1, 2, 3, 4] as const
const LEGEND = LEVELS.map((level) => ({ id: `l${level}`, color: `var(--usage-l${level})` }))

/** Arrow keys walk the calendar: left and right by a week, up and down by a day. */
const KEY_STEPS = new Map([
	['ArrowLeft', -7],
	['ArrowRight', 7],
	['ArrowUp', -1],
	['ArrowDown', 1],
])

/** Keeps today in view when the grid is wider than the page. */
function scrollToToday(element: HTMLDivElement | null) {
	if (element) element.scrollLeft = element.scrollWidth
}

/**
 * The last 52 weeks as a contribution grid: one cell per local day, Monday-first columns, shaded by
 * the quartiles of your own year. A headline and your streaks sit above it, the scale below it.
 */
export function UsageGrid({ days, lens = 'activity' }: { days: DayUsage[]; lens?: UsageLens }) {
	const frame = useRef<HTMLElement>(null)
	const [hover, setHover] = useState<{ day: DayUsage; anchor: TooltipAnchor } | null>(null)
	const [focusIndex, setFocusIndex] = useState(days.length - 1)

	const { weeks, months } = gridLayout(days)
	const thresholds = intensityThresholds(days.map((day) => lensValue(day, lens)))
	const streak = streaks(days)
	const head = headline(days, lens)
	const empty = days.every((day) => lensValue(day, lens) === 0)
	const tabStop = Math.min(focusIndex, days.length - 1)

	const show = (day: DayUsage, target: HTMLElement) => {
		if (frame.current) setHover({ day, anchor: anchorAbove(target, frame.current) })
	}
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = KEY_STEPS.get(event.key)
		if (step === undefined) return
		const next = tabStop + step
		if (next < 0 || next >= days.length) return
		event.preventDefault()
		setFocusIndex(next)
		event.currentTarget.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus()
	}

	return (
		<section className="usage-card" ref={frame} aria-label="Activity in the last year">
			<div className="usage-head">
				{empty ? (
					<>
						<span className="usage-sub">No activity yet. Start a task and it'll show up here.</span>
						<Link className="btn sm" to="/">
							New task
						</Link>
					</>
				) : (
					<div>
						<span className="usage-total">{head.total}</span>{' '}
						<span className="usage-sub">
							{head.span}
							{streak.current > 0 ? (
								<>
									{' · '}
									<b>{streak.current}-day streak</b>
								</>
							) : null}
							{streak.longest > 0 ? ` · longest ${streak.longest}` : null}
						</span>
					</div>
				)}
			</div>
			<div className="usage-scroll" ref={scrollToToday}>
				<div className="usage-year">
					<div className="usage-weekdays" aria-hidden="true">
						<span />
						{WEEKDAY_LABELS.map((label, row) => (
							<span key={row}>{label}</span>
						))}
					</div>
					<div>
						<div className="usage-months" aria-hidden="true">
							{months.map((month) => (
								<span key={month.column} style={{ gridColumnStart: month.column + 1 }}>
									{month.label}
								</span>
							))}
						</div>
						<div
							className="usage-cells"
							role="group"
							aria-label="Days"
							onKeyDown={onKeyDown}
							onPointerLeave={() => setHover(null)}
						>
							{weeks.map((week, column) =>
								week.map((cell) => {
									// The grid opens on a Monday, so a cell's column and weekday give its day's index.
									const cellIndex = column * 7 + cell.weekday
									const level = intensityLevel(lensValue(cell.day, lens), thresholds)
									return (
										<button
											key={cell.day.date}
											type="button"
											className={`usage-cell l${level}`}
											style={{ gridColumn: column + 1, gridRow: cell.weekday + 1 }}
											data-index={cellIndex}
											data-date={cell.day.date}
											tabIndex={cellIndex === tabStop ? 0 : -1}
											aria-label={cellLabel(cell.day, lens)}
											onPointerEnter={(event) => show(cell.day, event.currentTarget)}
											onFocus={(event) => {
												setFocusIndex(cellIndex)
												show(cell.day, event.currentTarget)
											}}
											onBlur={() => setHover(null)}
										/>
									)
								}),
							)}
						</div>
					</div>
				</div>
			</div>
			<div className="usage-foot">
				<span>Mon–Sun weeks · local time</span>
				<UsageLegend items={LEGEND} before="Less" after="More" />
			</div>
			{hover ? (
				<UsageTooltip
					anchor={hover.anchor}
					value={cellSummary(hover.day, lens)}
					detail={formatDayLong(hover.day.date)}
				/>
			) : null}
		</section>
	)
}
