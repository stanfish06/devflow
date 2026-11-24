// Linear-style status labels and icons for tasks on the board and list (copied from fractal-platform's
// workspace/meta.tsx, keyed by devflow's task statuses).
import type { TaskStatus } from '@devflow/schemas/effect/taskconfiguration'

import { cn } from '@/lib/utils'

/** Label and icon colour per status (Linear's palette: backlog/todo grey, in progress yellow, done indigo). */
export const TASK_STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
	backlog: { label: 'Backlog', color: '#95a2b3' },
	todo: { label: 'Todo', color: '#95a2b3' },
	in_progress: { label: 'In progress', color: '#f2c94c' },
	on_hold: { label: 'On hold', color: '#f2994a' },
	done: { label: 'Done', color: '#5e6ad2' },
	canceled: { label: 'Canceled', color: '#95a2b3' },
}

/** 14px status glyph: ring plus a fill that shows progress, or a solid disc with a mark for closed states. */
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
	const { color, label } = TASK_STATUS_META[status]
	const ring = <circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.5" />
	const glyph = {
		backlog: <circle cx="7" cy="7" r="6" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="1.4 1.75" />,
		// Solid empty ring = planned, not started.
		todo: ring,
		// Right half of an inner disc (r=3.5) = in progress.
		in_progress: (
			<>
				{ring}
				<path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill={color} />
			</>
		),
		on_hold: (
			<>
				{ring}
				<path d="M5.5 4.5v5M8.5 4.5v5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
			</>
		),
		done: (
			<>
				<circle cx="7" cy="7" r="7" fill={color} />
				<path
					d="M4.2 7.2 6.2 9.1 9.9 5.1"
					fill="none"
					stroke="var(--color-background)"
					strokeWidth="1.6"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</>
		),
		canceled: (
			<>
				<circle cx="7" cy="7" r="7" fill={color} />
				<path d="M4.8 9.2 9.2 4.8" stroke="var(--color-background)" strokeWidth="1.8" strokeLinecap="round" />
			</>
		),
	}[status]
	return (
		<svg viewBox="0 0 14 14" className={cn('size-3.5 shrink-0', className)} role="img" aria-label={label}>
			<title>{label}</title>
			{glyph}
		</svg>
	)
}
