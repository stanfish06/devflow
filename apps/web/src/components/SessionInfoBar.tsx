import { Badge } from '@devflow/ui/components/badge'
import { Button } from '@devflow/ui/components/button'
import { Input } from '@devflow/ui/components/input'
import { Popover, PopoverContent, PopoverTrigger } from '@devflow/ui/components/popover'
import { type SessionLabel, SessionLabelBadge } from '@devflow/ui/components/session-label-badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@devflow/ui/components/tooltip'
import { cn } from '@devflow/ui/lib/utils'
import { useCopyToClipboard } from '@uidotdev/usehooks'
import { Copy, Monitor, SquareSplitHorizontal, SquareSplitVertical } from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'

import { useSessionDetail } from '@/components/session-detail/session-detail-context'
import { useTaskTicket } from '@/hooks/live-queries/useTaskTicket'
import { FOCUSED_AREAS } from '@/hooks/stores/focus-areas'
import { useFocusStore } from '@/hooks/stores/focusStore'
import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { openExternal } from '@/lib/url-opener'

/**
 * The info bar above the conversation stream on the session detail page:
 * working directory with a copy action, diff-style toggle, session labels,
 * and ticket badge.
 */
export function SessionInfoBar() {
	const { session, canSendPrompt } = useSessionDetail()
	const ticket = useTaskTicket(session.task_id)

	// Lights up while the main (conversation) area owns keyboard focus.
	const isMainAreaFocused = useFocusStore((s) => s.focusedArea === FOCUSED_AREAS.MAIN)
	const diffStyle = useSettingsStore((s) => s.diffStyle)
	const setDiffStyle = useSettingsStore((s) => s.setDiffStyle)
	const [, copyToClipboard] = useCopyToClipboard()

	const handleCopyWorkingDir = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			if (!session.working_directory) return
			void copyToClipboard(session.working_directory)
			toast.success('Copied to clipboard')
		},
		[session.working_directory, copyToClipboard],
	)

	return (
		<TooltipProvider>
			<div
				className={cn(
					'shrink-0 flex h-9 items-center justify-between px-2 text-xs text-muted-foreground',
					isMainAreaFocused && 'bg-accent/10',
				)}
			>
				<div className="flex min-w-0 flex-1 items-center gap-1">
					<div className="inline-flex items-center gap-1 min-w-0 flex-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									onClick={handleCopyWorkingDir}
									className="h-auto min-w-0 flex-1 justify-start border-transparent p-0 text-sm normal-case tracking-normal text-foreground hover:bg-transparent hover:border-transparent hover:text-[var(--terminal-accent)]"
									aria-label="Copy working directory"
								>
									<span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
										{session.working_directory}
									</span>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom" className="max-w-md break-all font-mono text-xs">
								{session.working_directory}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="h-5 w-5"
									onClick={handleCopyWorkingDir}
									aria-label="Copy working directory"
								>
									<Copy className="w-3 h-3" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>Copy working directory</p>
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={(e) => {
										e.stopPropagation()
										setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')
									}}
									variant="ghost"
									size="icon"
									className="w-5 h-5"
									aria-label="Toggle diff view"
								>
									{diffStyle === 'split' ? (
										<SquareSplitVertical className="w-3 h-3" />
									) : (
										<SquareSplitHorizontal className="w-3 h-3" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								<p>
									{diffStyle === 'split' ? 'Switch to inline diff view' : 'Switch to split diff view'}
								</p>
							</TooltipContent>
						</Tooltip>
					</div>
					{/* Session labels */}
					{Array.isArray(session.labels) && session.labels.length > 0 && (
						<div className="flex gap-1.5 items-center">
							{(session.labels as SessionLabel[]).map((label) => (
								<SessionLabelBadge key={label.name} label={label} />
							))}
						</div>
					)}
					{/* Read-only badge for shared sessions */}
					{!canSendPrompt && (
						<Badge variant="outline" className="text-xs">
							READ-ONLY
						</Badge>
					)}
					{/* Ticket badge from deterministic task-level ticket_id */}
					{ticket?.ticket_id && (
						<div className="flex gap-1.5 items-center">
							{ticket.ticket_url ? (
								<Button
									variant="outline"
									size="sm"
									className="h-5 px-1.5 text-[10px] font-mono"
									onClick={() => openExternal(ticket.ticket_url ?? '')}
								>
									{ticket.ticket_id}
								</Button>
							) : (
								<Button
									variant="outline"
									size="sm"
									className="h-5 px-1.5 text-[10px] font-mono pointer-events-none"
								>
									{ticket.ticket_id}
								</Button>
							)}
						</div>
					)}
				</div>
			</div>
		</TooltipProvider>
	)
}

export function HostRenameControl({
	hostDisplayName,
	renameOpen,
	renameValue,
	onOpenRename,
	onOpenChange,
	onRenameValueChange,
	onSaveRename,
	className,
}: {
	hostDisplayName?: string | null
	renameOpen: boolean
	renameValue: string
	onOpenRename: () => void
	onOpenChange: (open: boolean) => void
	onRenameValueChange: (value: string) => void
	onSaveRename: () => void
	className?: string
}) {
	if (!hostDisplayName) return null

	return (
		<Popover open={renameOpen} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						'inline-flex h-5 min-w-0 items-center gap-1 text-sm hover:text-foreground transition-colors cursor-pointer',
						className,
					)}
					onClick={onOpenRename}
				>
					<span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
						<Monitor className="h-3 w-3 text-accent" />
					</span>
					<span className="min-w-0 truncate">{hostDisplayName}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-3" align="end">
				<div className="space-y-2">
					<p className="text-xs font-medium">Rename host</p>
					<Input
						autoFocus
						value={renameValue}
						onChange={(e) => onRenameValueChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								onSaveRename()
							}
						}}
						placeholder="Display name..."
						className="h-7 text-xs"
					/>
					<div className="flex justify-end gap-1">
						<Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button size="sm" className="h-6 text-xs" onClick={onSaveRename}>
							Save
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
