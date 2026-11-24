// Linear-style views of tasks grouped by board status, copied from fractal-platform's
// workspace/status-views.tsx: a board (drag a card to another column to change its status) and a list
// with collapsible groups. Both open the task on click (a draft opens in the composer); + starts a new
// task in that status. Each card shows its agent's state, with Start, Stop, Resume or Retry on hover.
// The column and the agent are independent: moving a card never touches its agent, and the reverse.
import { TASK_STATUSES, type TaskStatus } from '@devflow/schemas/effect/taskconfiguration'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@devflow/ui/components/dropdown-menu'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'

import { useBrowserAuth as useAuth } from '@/hooks/use-browser-auth'
import { assignStage, type StageId } from '@/lib/kanban/columnEngine'
import { cn } from '@/lib/utils'
import { AgentStateLabel, CardActionButton } from '@/minimalist/components/CardAction'
import { Segmented } from '@/minimalist/components/SettingsControls'
import { TASK_STATUS_META, TaskStatusIcon } from '@/minimalist/components/TaskStatusIcon'
import { type CardAction, cardAgent } from '@/minimalist/lib/card-agent'
import { type TaskRow, type TaskTreeScope, useHosts, useProjects, useTaskTree } from '@/minimalist/lib/data'
import { startBlocker } from '@/minimalist/lib/draft-blocker'
import { useUi } from '@/minimalist/lib/ui-state'
import { useCardAction } from '@/minimalist/lib/use-card-action'
import { useApi } from '@/orpc/client'

// ── Options ──────────────────────────────────────────────────────────────────
// Board columns share the width between min-w-[200px] and max-w-[360px] (BoardView); below the
// minimum the board scrolls sideways.
const DRAG_TYPE = 'application/x-devflow-task'

export type BoardLayout = 'board' | 'list'

const SCOPES: Array<{ value: TaskTreeScope; label: string }> = [
	{ value: 'mine', label: 'Mine' },
	{ value: 'everyone', label: 'Everyone' },
]
const LAYOUTS: Array<{ value: BoardLayout; label: string }> = [
	{ value: 'board', label: 'Board' },
	{ value: 'list', label: 'List' },
]
/** Each workflow stage's tag text and color; the colors are minimalist theme variables (styles.css). */
const STAGES: Record<StageId, { label: string; color: string }> = {
	'research-design': { label: 'Research & Design', color: 'var(--stage-research)' },
	planning: { label: 'Planning', color: 'var(--stage-planning)' },
	implementation: { label: 'Implementation', color: 'var(--stage-implementation)' },
	'in-review': { label: 'In Review', color: 'var(--stage-review)' },
}

type ViewProps = {
	rows: TaskRow[]
	onOpen: (row: TaskRow) => void
	onCreate: (status: TaskStatus) => void
	controls: CardControls
}

/** What a card's action button needs: a way to run the action, and why a Start can't run. */
type CardControls = {
	run: (row: TaskRow, action: NonNullable<CardAction>) => Promise<void>
	startBlocker: (row: TaskRow) => string | null
}

/** The task's status icon as a button: a menu of statuses, the keyboard path besides dragging. */
function StatusMenu(props: { taskId: string; taskName: string; status: TaskStatus; className?: string }) {
	const setStatus = useSetTaskStatus()
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Status of ${props.taskName}: ${TASK_STATUS_META[props.status].label}`}
				className={cn('rounded p-0.5 hover:bg-accent/10', props.className)}
			>
				<TaskStatusIcon status={props.status} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{TASK_STATUSES.map((status) => (
					<DropdownMenuItem
						key={status}
						disabled={status === props.status}
						onSelect={() => void setStatus(props.taskId, status)}
					>
						<TaskStatusIcon status={status} />
						{TASK_STATUS_META[status].label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/** Stores a task's board status; a failure shows a toast. */
function useSetTaskStatus() {
	const { client: api } = useApi()
	const { showToast } = useUi()
	return async (taskId: string, status: TaskStatus) => {
		try {
			await api.tasks.update({ taskId, status })
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not change the status')
		}
	}
}

/** Tasks grouped by status, in board order. */
function statusGroups(rows: TaskRow[]) {
	return TASK_STATUSES.map((status) => ({ status, rows: rows.filter((row) => row.task.status === status) }))
}

/** The workflow stage of a task's latest-active labeled session, or null when it has none. */
function stageOf(row: TaskRow): StageId | null {
	return assignStage(
		row.sessions.map((session) => ({
			archived: session.archived,
			labels: session.labels,
			last_activity_at: session.last_activity_at,
		})),
	)
}

function shortDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** When the card last changed: a draft was saved, a started ticket updated. */
function updatedText(row: TaskRow): string {
	return `${row.task.is_draft ? 'Saved' : 'Updated'} ${shortDate(row.lastActivity)}`
}

/**
 * Card actions for the board: one runner, and Start's blockers from one read of hosts and
 * projects. A draft starts only on the host and project it was saved for, and only its owner can
 * start it.
 */
function useCardControls(): CardControls {
	const run = useCardAction()
	const { user } = useAuth()
	const { hosts, isReady: hostsReady } = useHosts()
	const projects = useProjects()
	return {
		run,
		startBlocker: (row) => {
			if (row.task.resource_owner_user_id !== user?.id) return 'Only its owner can start this draft'
			if (!hostsReady) return 'Loading…'
			return startBlocker(row, hosts, projects.data)
		},
	}
}

function Chip(props: { children: string }) {
	return (
		<span className="max-w-full truncate rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
			{props.children}
		</span>
	)
}

/** The task's workflow stage as a colored tag; nothing when it has none. */
export function StageTag(props: { stage: StageId | null }) {
	if (props.stage === null) return null
	const { label, color } = STAGES[props.stage]
	return (
		<span
			data-stage={props.stage}
			className="inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pr-2 pl-[7px] text-[0.6875rem] font-medium"
			style={{
				color,
				backgroundColor: `color-mix(in oklab, ${color} var(--stage-tint), transparent)`,
				borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
			}}
		>
			<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
			{label}
		</span>
	)
}

/** Tasks as a Linear-style board or list, grouped by status. */
export function BoardPage({ layout, onLayout }: { layout: BoardLayout; onLayout: (layout: BoardLayout) => void }) {
	const [scope, setScope] = useState<TaskTreeScope>('everyone')
	const { recent: rows, isReady } = useTaskTree(false, scope)
	const navigate = useNavigate()
	const { closeSidebarOnNarrow } = useUi()
	const onOpen = ({ task }: TaskRow) => {
		closeSidebarOnNarrow()
		// A draft has no thread yet: it opens in the composer it was written in, to edit or Start.
		if (task.is_draft) void navigate({ to: '/', search: { task: task.id } })
		else void navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })
	}
	const onCreate = (status: TaskStatus) => void navigate({ to: '/', search: { status } })
	const controls = useCardControls()
	return (
		<main className="main board">
			<div className="titlebar">
				<span className="title">Board</span>
				<span className="meta">{rows.length}</span>
				<span className="sp" />
				<Segmented label="Show" value={scope} options={SCOPES} onChange={setScope} />
				<Segmented label="Layout" value={layout} options={LAYOUTS} onChange={onLayout} />
			</div>
			{isReady && rows.length === 0 ? (
				<div className="hero">
					<h1 className="status">{scope === 'mine' ? 'No tasks of yours yet' : 'No tasks yet'}</h1>
					<Link className="btn" to="/">
						New task
					</Link>
				</div>
			) : (
				// The shared components' boundary: Tailwind and the theme tokens, outside the minimalist resets.
				<div className="minimalist-shared min-h-0 flex-1 bg-background text-foreground">
					{layout === 'board' ? (
						<BoardView rows={rows} onOpen={onOpen} onCreate={onCreate} controls={controls} />
					) : (
						<StatusListView rows={rows} onOpen={onOpen} onCreate={onCreate} controls={controls} />
					)}
				</div>
			)}
		</main>
	)
}

function BoardView(props: ViewProps) {
	const groups = statusGroups(props.rows)
	const setStatus = useSetTaskStatus()
	const [over, setOver] = useState<TaskStatus | null>(null)
	return (
		<div className="flex h-full min-h-0 gap-3 overflow-x-auto p-3">
			{groups.map(({ status, rows: column }) => (
				// biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragged cards
				<section
					key={status}
					data-status={status}
					aria-label={TASK_STATUS_META[status].label}
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
						event.preventDefault()
						setOver(status)
					}}
					onDragLeave={() => setOver((current) => (current === status ? null : current))}
					onDrop={(event) => {
						event.preventDefault()
						setOver(null)
						const taskId = event.dataTransfer.getData(DRAG_TYPE)
						if (taskId && props.rows.find((row) => row.task.id === taskId)?.task.status !== status)
							void setStatus(taskId, status)
					}}
					className={cn(
						'flex min-w-[200px] max-w-[360px] flex-1 flex-col rounded-lg bg-muted/30',
						over === status && 'ring-1 ring-foreground/30',
					)}
				>
					<div className="flex h-10 shrink-0 items-center gap-2 px-3 text-sm">
						<TaskStatusIcon status={status} />
						<span className="font-medium">{TASK_STATUS_META[status].label}</span>
						<span className="flex-1 text-muted-foreground">{column.length}</span>
						<button
							type="button"
							aria-label={`New task in ${TASK_STATUS_META[status].label}`}
							className="rounded p-1 text-muted-foreground hover:bg-accent/10 hover:text-foreground"
							onClick={() => props.onCreate(status)}
						>
							<Plus className="size-4" />
						</button>
					</div>
					<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
						{column.map((row) => (
							<Card key={row.task.id} row={row} onOpen={props.onOpen} controls={props.controls} />
						))}
					</div>
				</section>
			))}
		</div>
	)
}

function Card(props: { row: TaskRow; onOpen: (row: TaskRow) => void; controls: CardControls }) {
	const { task } = props.row
	const agent = cardAgent(props.row)
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag source; the buttons inside are the interactive parts
		<div
			data-task-id={task.id}
			draggable
			onDragStart={(event) => {
				event.dataTransfer.setData(DRAG_TYPE, task.id)
				event.dataTransfer.effectAllowed = 'move'
			}}
			className="group relative flex w-full items-start gap-2 rounded-lg border bg-card p-3 focus-within:border-foreground/30 hover:border-foreground/30"
		>
			<StatusMenu taskId={task.id} taskName={task.name} status={task.status} className="-m-0.5 mt-0" />
			<button type="button" onClick={() => props.onOpen(props.row)} className="min-w-0 flex-1 text-left">
				<span className="line-clamp-2 text-[0.8125rem] font-medium">{task.name}</span>
				<span className="mt-2 flex flex-wrap gap-1.5">
					<StageTag stage={stageOf(props.row)} />
					<Chip>{props.row.projectName}</Chip>
				</span>
				<span className="mt-2 flex flex-wrap items-center gap-1 text-[0.6875rem] text-muted-foreground">
					<AgentStateLabel state={agent.state} />
					<span>· {updatedText(props.row)}</span>
				</span>
			</button>
			<RowAction
				row={props.row}
				action={agent.action}
				controls={props.controls}
				className="absolute top-2 right-2"
			/>
		</div>
	)
}

/** A card's or list row's action button, with Start's blocker when it's a Start. */
function RowAction(props: { row: TaskRow; action: CardAction; controls: CardControls; className?: string }) {
	return (
		<CardActionButton
			action={props.action}
			taskName={props.row.task.name}
			blocker={props.action?.kind === 'start' ? props.controls.startBlocker(props.row) : null}
			onRun={(action) => props.controls.run(props.row, action)}
			className={props.className}
		/>
	)
}

function StatusListView(props: ViewProps) {
	const groups = statusGroups(props.rows)
	const [closed, setClosed] = useState<Set<TaskStatus>>(new Set())
	const toggle = (status: TaskStatus) =>
		setClosed((current) => {
			const next = new Set(current)
			if (next.has(status)) next.delete(status)
			else next.add(status)
			return next
		})
	return (
		<div className="h-full min-h-0 overflow-y-auto p-3">
			{groups.map(({ status, rows }) => (
				<section key={status} className="mb-2" aria-label={TASK_STATUS_META[status].label}>
					<div className="flex h-9 items-center gap-2 rounded-md bg-muted/40 px-2 text-sm">
						<button
							type="button"
							onClick={() => toggle(status)}
							className="flex flex-1 items-center gap-2 text-left"
							aria-expanded={!closed.has(status)}
						>
							<ChevronRight
								className={cn(
									'size-3.5 text-muted-foreground transition-transform',
									!closed.has(status) && 'rotate-90',
								)}
							/>
							<TaskStatusIcon status={status} />
							<span className="font-medium">{TASK_STATUS_META[status].label}</span>
							<span className="text-muted-foreground">{rows.length}</span>
						</button>
						<button
							type="button"
							aria-label={`New task in ${TASK_STATUS_META[status].label}`}
							className="rounded p-1 text-muted-foreground hover:bg-accent/10 hover:text-foreground"
							onClick={() => props.onCreate(status)}
						>
							<Plus className="size-4" />
						</button>
					</div>
					{!closed.has(status) &&
						rows.map((row) => (
							<ListRow key={row.task.id} row={row} onOpen={props.onOpen} controls={props.controls} />
						))}
				</section>
			))}
		</div>
	)
}

function ListRow(props: { row: TaskRow; onOpen: (row: TaskRow) => void; controls: CardControls }) {
	const { row } = props
	const agent = cardAgent(row)
	return (
		<div className="group flex h-10 w-full items-center gap-3 rounded-md px-3 text-[0.8125rem] hover:bg-accent/10">
			<StatusMenu taskId={row.task.id} taskName={row.task.name} status={row.task.status} />
			<button
				type="button"
				onClick={() => props.onOpen(row)}
				className="flex h-full min-w-0 flex-1 items-center gap-3 text-left"
			>
				<span className="min-w-0 flex-1 truncate">{row.task.name}</span>
				{/* The stage tag stays at every width; below md the project chip makes room for it. */}
				<span className="flex shrink-0 items-center gap-1.5">
					<StageTag stage={stageOf(row)} />
					<span className="hidden md:contents">
						<Chip>{row.projectName}</Chip>
					</span>
				</span>
				<AgentStateLabel state={agent.state} className="shrink-0 text-xs" />
				<span className="min-w-14 shrink-0 text-right text-xs text-muted-foreground">
					{shortDate(row.lastActivity)}
				</span>
			</button>
			{/* A fixed slot, so dates line up whether or not a row has an action. */}
			<span className="flex w-20 shrink-0 justify-end">
				<RowAction row={row} action={agent.action} controls={props.controls} />
			</span>
		</div>
	)
}
