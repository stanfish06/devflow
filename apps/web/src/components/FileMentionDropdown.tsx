import { fuzzySearch, highlightMatches } from '@devflow/ui/lib/fuzzy-search'
import { cn } from '@devflow/ui/lib/utils'
import { FileText } from 'lucide-react'
import { type Ref, useCallback, useImperativeHandle, useRef, useState } from 'react'

import { type TaskArtifact, useTaskArtifacts } from '@/hooks/live-queries/useTaskArtifacts'

interface FileMentionDropdownProps {
	query: string
	command: (item: { id: string; label: string; isDirectory: boolean; isArtifact: boolean }) => void
	taskId: string | null
	/** Imperative handle ref — a normal prop in React 19 (no forwardRef needed). */
	ref?: Ref<FileMentionDropdownRef>
}

export interface FileMentionDropdownRef {
	onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

/** `@` mention suggestions: the task's artifacts, fuzzy-filtered by the typed query. */
export const FileMentionDropdown = ({ query, command, taskId, ref }: FileMentionDropdownProps) => {
	// Co-locate the navigation index with the query it belongs to.
	// When query changes, selectedIndex automatically derives as 0 — no effect or
	// render-time setState mutation needed.
	const [navState, setNavState] = useState<{ query: string; index: number }>({ query, index: 0 })
	const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

	// Fetch artifacts for the task
	const artifacts = useTaskArtifacts(taskId ?? '')

	// Fuzzy filter artifacts by query
	const filteredArtifacts =
		query && artifacts.length > 0
			? fuzzySearch(artifacts, query, {
					keys: ['file_name'],
					threshold: 0.01,
					minMatchCharLength: 1,
				})
			: artifacts.map((a) => ({
					score: 1,
					indices: [],
					item: a,
					matches: [],
				}))

	// Derive the total result count and the selected index in one place.
	// When query changes, navState.query !== query so selectedIndex derives as 0.
	// Clamp to valid range so a stale index after results change is never out of bounds.
	const totalResults = filteredArtifacts.length
	const selectedIndex =
		totalResults > 0 ? Math.min(navState.query === query ? navState.index : 0, totalResults - 1) : 0

	const handleSelect = useCallback(
		(artifact: TaskArtifact) => {
			const path = `.devflow/tasks/${artifact.task_slug}/${artifact.file_name}`
			command({
				id: `@${path}`,
				label: artifact.file_name,
				isDirectory: false,
				isArtifact: true,
			})
		},
		[command],
	)

	const onKeyDown = useCallback(
		({ event }: { event: KeyboardEvent }) => {
			if (totalResults === 0) return false

			if (event.key === 'ArrowUp') {
				event.preventDefault()
				const newIndex = (selectedIndex - 1 + totalResults) % totalResults
				setNavState({ query, index: newIndex })
				buttonRefs.current[newIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
				return true
			}
			if (event.key === 'ArrowDown') {
				event.preventDefault()
				const newIndex = (selectedIndex + 1) % totalResults
				setNavState({ query, index: newIndex })
				buttonRefs.current[newIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
				return true
			}
			if (event.key === 'Enter') {
				event.preventDefault()
				const selected = filteredArtifacts[selectedIndex]
				if (selected) handleSelect(selected.item as TaskArtifact)
				return true
			}
			return false
		},
		[totalResults, selectedIndex, query, filteredArtifacts, handleSelect],
	)

	useImperativeHandle(ref, () => ({ onKeyDown }))

	if (totalResults === 0 && !taskId) {
		return <div className="px-3 py-2 text-sm text-muted-foreground">No task selected: artifacts unavailable</div>
	}

	if (totalResults === 0) {
		return <div className="px-3 py-2 text-sm text-muted-foreground">No matches found</div>
	}

	return (
		<div className="max-h-[360px] overflow-y-auto flex flex-col">
			{/* Artifacts Section */}
			{filteredArtifacts.length > 0 && (
				<>
					<div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
						Artifacts
					</div>
					{filteredArtifacts.map((match, index) => {
						const artifact = match.item as TaskArtifact
						const nameIndices = match.matches.find((m) => m.key === 'file_name')?.indices ?? []
						const highlighted =
							nameIndices.length > 0 ? highlightMatches(artifact.file_name, nameIndices) : null

						return (
							<button
								key={artifact.id}
								ref={(el) => {
									buttonRefs.current[index] = el
								}}
								type="button"
								className={cn(
									'group w-full flex items-center gap-2 px-2 py-1 text-sm text-left hover:bg-accent hover:text-background',
									index === selectedIndex && 'bg-accent text-background',
								)}
								onMouseEnter={() => setNavState({ query, index })}
								onClick={() => handleSelect(artifact)}
							>
								<FileText
									className={cn(
										'h-4 w-4 flex-shrink-0 text-[var(--terminal-accent)] group-hover:text-background',
										index === selectedIndex && 'text-background',
									)}
								/>
								<span className="truncate">
									{highlighted
										? highlighted.map((seg, i) => (
												<span
													key={i}
													className={cn(seg.highlighted && 'bg-accent/40 font-medium')}
												>
													{seg.text}
												</span>
											))
										: artifact.file_name}
								</span>
							</button>
						)
					})}
				</>
			)}
		</div>
	)
}
