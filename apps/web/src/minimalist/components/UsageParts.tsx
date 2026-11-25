// Pieces the usage page's visuals share: one tooltip, one legend and one switch, so the year grid and
// the cost chart read the same way.
import { selectWithArrows } from '@/minimalist/lib/roving'

/** Where a tooltip points, in pixels from its positioned container's top-left corner. */
export type TooltipAnchor = { left: number; top: number; align: 'start' | 'center' | 'end' }

/** Room a centred tooltip needs on either side before it is pinned to an edge instead. */
const EDGE_ROOM = 150

/** A tooltip anchor above `target`'s centre, relative to `container`, pinned to an edge when near one. */
export function anchorAbove(target: HTMLElement, container: HTMLElement): TooltipAnchor {
	const box = target.getBoundingClientRect()
	const frame = container.getBoundingClientRect()
	const left = box.left - frame.left + box.width / 2
	const top = box.top - frame.top
	if (left < EDGE_ROOM) return { left, top, align: 'start' }
	if (left > frame.width - EDGE_ROOM) return { left, top, align: 'end' }
	return { left, top, align: 'center' }
}

/** A tooltip row: one series' value, keyed by a short stroke of its colour. */
export type TooltipRow = { id: string; color: string; label: string; value: string }

/**
 * The value leads in bold; what and when follow. Optional rows break a value down by series, each value
 * strong and its name secondary, keyed by a stroke of the series colour rather than a filled box.
 */
export function UsageTooltip({
	anchor,
	value,
	detail,
	rows = [],
}: {
	anchor: TooltipAnchor
	value: string
	detail?: string
	rows?: TooltipRow[]
}) {
	return (
		<div
			className="usage-tip"
			role="tooltip"
			data-align={anchor.align}
			style={{ left: anchor.left, top: anchor.top }}
		>
			<b>{value}</b>
			{detail ? ` · ${detail}` : null}
			{rows.length > 0 ? (
				<span className="rows">
					{rows.map((row) => (
						<span key={row.id} className="row">
							<span className="key" style={{ background: row.color }} aria-hidden="true" />
							<b>{row.value}</b> <span className="name">{row.label}</span>
						</span>
					))}
				</span>
			) : null}
		</div>
	)
}

export type LegendItem = { id: string; color: string; label?: string }

/** Swatches with optional labels, framed by optional words: the grid's Less → More scale uses it bare. */
export function UsageLegend({ items, before, after }: { items: LegendItem[]; before?: string; after?: string }) {
	return (
		<span className="usage-legend">
			{before ? <span>{before}</span> : null}
			{items.map((item) => (
				<span key={item.id} className="item">
					<span className="sw" style={{ background: item.color }} aria-hidden="true" />
					{item.label ? <span>{item.label}</span> : null}
				</span>
			))}
			{after ? <span>{after}</span> : null}
		</span>
	)
}

/**
 * A segmented control for a small set of views, such as the grid's Activity / Tokens / Cost lenses.
 * A radio group: one tab stop, arrow keys move the choice.
 */
export function UsageSwitch<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string
	value: T
	options: ReadonlyArray<{ value: T; label: string }>
	onChange: (value: T) => void
}) {
	return (
		<div className="seg usage-switch" role="radiogroup" aria-label={label} onKeyDown={selectWithArrows}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					tabIndex={value === option.value ? 0 : -1}
					className={value === option.value ? 'on' : undefined}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}
