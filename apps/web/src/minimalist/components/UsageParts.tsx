// Pieces the usage page's visuals share: one tooltip and one legend, so the year grid and the cost
// chart read the same way.

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

/** The value leads in bold; what and when follow. */
export function UsageTooltip({ anchor, value, detail }: { anchor: TooltipAnchor; value: string; detail?: string }) {
	return (
		<div
			className="usage-tip"
			role="tooltip"
			data-align={anchor.align}
			style={{ left: anchor.left, top: anchor.top }}
		>
			<b>{value}</b>
			{detail ? ` · ${detail}` : null}
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
