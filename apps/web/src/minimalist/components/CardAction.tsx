// A board card's agent controls: the state label its footer always shows, and the one action
// that appears on hover or keyboard focus (always, on touch screens). Tailwind, since cards sit
// inside the board's .minimalist-shared island.
import { type LucideIcon, Play, RotateCw, Square } from 'lucide-react'
import { useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { CARD_STATE_LABELS, type CardAction, type CardState } from '@/minimalist/lib/card-agent'

const ACTIONS: Record<NonNullable<CardAction>['kind'], { label: string; icon: LucideIcon; filled: boolean }> = {
	start: { label: 'Start', icon: Play, filled: true },
	stop: { label: 'Stop', icon: Square, filled: true },
	resume: { label: 'Resume', icon: RotateCw, filled: false },
	retry: { label: 'Retry', icon: RotateCw, filled: false },
}

/**
 * The card's next action. Hidden until the card is hovered or holds focus; on a device that
 * can't hover it always shows. A blocked action stays focusable, greyed, with the reason as its
 * title. Clicks never reach the card, so the action never opens it too.
 */
export function CardActionButton(props: {
	action: CardAction
	taskName: string
	/** Why the action can't run now; null when it can. */
	blocker: string | null
	onRun: (action: NonNullable<CardAction>) => Promise<void>
	className?: string
}) {
	const lock = useRef(false)
	const [pending, setPending] = useState(false)
	const { action } = props
	if (!action) return null
	const { label, icon: Icon, filled } = ACTIONS[action.kind]
	const blocked = Boolean(props.blocker) || pending
	return (
		<button
			type="button"
			aria-label={`${label} ${props.taskName}`}
			aria-disabled={blocked || undefined}
			aria-busy={pending || undefined}
			title={props.blocker ?? undefined}
			data-card-action={action.kind}
			onClick={(event) => {
				event.stopPropagation()
				if (blocked || lock.current) return
				lock.current = true
				setPending(true)
				void props.onRun(action).finally(() => {
					lock.current = false
					setPending(false)
				})
			}}
			className={cn(
				'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 text-[0.71875rem] font-medium text-foreground',
				'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
				blocked ? 'cursor-not-allowed text-muted-foreground' : 'hover:bg-muted',
				props.className,
			)}
		>
			<Icon className="size-3" strokeWidth={2} fill={filled ? 'currentColor' : 'none'} aria-hidden />
			{label}
		</button>
	)
}

/** The card's agent state, always shown: a mark and a word, never color alone. */
export function AgentStateLabel(props: { state: CardState; className?: string }) {
	return (
		<span
			data-agent-state={props.state}
			className={cn('inline-flex items-center gap-[5px] font-medium text-muted-foreground', props.className)}
		>
			<StateMark state={props.state} />
			{CARD_STATE_LABELS[props.state]}
		</span>
	)
}

function StateMark({ state }: { state: CardState }) {
	switch (state) {
		case 'draft':
			return (
				<span
					aria-hidden
					className="size-2 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground"
				/>
			)
		case 'running':
			return (
				<span
					aria-hidden
					className="size-[9px] shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--terminal-info)] border-r-transparent"
				/>
			)
		default:
			return <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', DOT_COLORS[state])} />
	}
}

const DOT_COLORS: Record<Exclude<CardState, 'draft' | 'running'>, string> = {
	'needs-you': 'bg-[#f59e0b]',
	failed: 'bg-destructive',
	stopped: 'bg-[var(--terminal-info)]',
	finished: 'bg-[var(--terminal-success)]',
}
