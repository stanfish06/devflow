import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@devflow/ui/components/command'
import { Input } from '@devflow/ui/components/input'
import { Popover, PopoverAnchor, PopoverContent } from '@devflow/ui/components/popover'
import { type FuzzyMatch, fuzzySearch, highlightMatches } from '@devflow/ui/lib/fuzzy-search'
import { cn } from '@devflow/ui/lib/utils'
import { Clock } from 'lucide-react'
import type React from 'react'
import { useReducer, useRef } from 'react'

import { useMountEffect } from '@/hooks/useMountEffect'

type RecentPreviewItem = { path: string; matches?: FuzzyMatch['matches'] }

interface DirectorySearchState {
	dropdownOpen: boolean
	isFocused: boolean
	recentPreview: RecentPreviewItem[]
	selectedIndex: number
}

type DirectorySearchAction =
	| { type: 'focus' }
	| { type: 'blur' }
	| { type: 'closeDropdown' }
	| { type: 'inputChanged'; recentPreview: RecentPreviewItem[]; dropdownOpen: boolean }
	| { type: 'openWithRecent'; recentPreview: RecentPreviewItem[] }
	| { type: 'moveSelection'; selectedIndex: number }

const initialDirectorySearchState: DirectorySearchState = {
	dropdownOpen: false,
	isFocused: false,
	recentPreview: [],
	selectedIndex: 0,
}

function directorySearchReducer(state: DirectorySearchState, action: DirectorySearchAction): DirectorySearchState {
	switch (action.type) {
		case 'focus':
			return { ...state, isFocused: true }
		case 'blur':
			return { ...state, isFocused: false }
		case 'closeDropdown':
			return { ...state, dropdownOpen: false }
		case 'inputChanged':
			return {
				...state,
				dropdownOpen: action.dropdownOpen,
				recentPreview: action.recentPreview,
				selectedIndex: 0,
			}
		case 'openWithRecent':
			return { ...state, dropdownOpen: true, recentPreview: action.recentPreview }
		case 'moveSelection':
			return { ...state, selectedIndex: action.selectedIndex }
	}
}

function HighlightedInline({
	text,
	matches,
	matchKey,
}: {
	text: string
	matches?: FuzzyMatch['matches']
	matchKey: string
}) {
	const match = matches?.find((m) => m.key === matchKey)
	if (!match) return text
	return highlightMatches(text, match.indices).map((segment, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional fragments of one string
		<span key={i} className={cn(segment.highlighted && 'bg-accent/40 font-medium')}>
			{segment.text}
		</span>
	))
}

function RecentDirectoryGroup({
	items,
	selectedIndex,
	onSelect,
}: {
	items: RecentPreviewItem[]
	selectedIndex: number
	onSelect: (path: string) => void
}) {
	if (items.length === 0) return null
	return (
		<CommandGroup heading="Recent Directories">
			{items.map((item, idx) => (
				<CommandItem
					key={`recent-${item.path}`}
					className={cn(
						'cursor-pointer',
						selectedIndex === idx && '!bg-accent/20',
						'data-[selected=true]:!bg-accent/20',
						'[&[data-selected=true]]:text-foreground',
					)}
					onSelect={() => onSelect(item.path)}
				>
					<div className="flex items-center gap-2 w-full">
						<Clock className="w-4 h-4 flex-shrink-0" />
						<span className="flex-1 truncate font-mono text-sm">
							<HighlightedInline text={item.path} matches={item.matches} matchKey="path" />
						</span>
					</div>
				</CommandItem>
			))}
		</CommandGroup>
	)
}

function DirectorySearchResults({
	recentPreview,
	selectedIndex,
	onSelectRecent,
}: {
	recentPreview: RecentPreviewItem[]
	selectedIndex: number
	onSelectRecent: (path: string) => void
}) {
	return (
		<Command>
			<CommandList>
				{recentPreview.length === 0 && (
					<CommandEmpty className="py-2 text-sm text-muted-foreground">No matching directories</CommandEmpty>
				)}
				<RecentDirectoryGroup items={recentPreview} selectedIndex={selectedIndex} onSelect={onSelectRecent} />
			</CommandList>
		</Command>
	)
}

interface DirectorySearchInputWithFilesystemProps {
	id?: string
	ref?: React.Ref<HTMLInputElement>
	'aria-label'?: string
	value?: string
	onChange?: (value: string) => void
	onConfirm?: (path: string) => void
	onBlur?: (path: string) => void
	placeholder?: string
	recentDirectories?: string[]
	className?: string
	style?: React.CSSProperties
	disabled?: boolean
	autoFocus?: boolean
}

/** A directory path input that suggests the host's recent directories as you type. */
export function DirectorySearchInputWithFilesystem({
	id,
	ref,
	'aria-label': ariaLabel,
	value = '',
	onChange,
	onConfirm,
	onBlur,
	placeholder = 'where are you writing code today?',
	recentDirectories = [],
	className,
	style,
	disabled = false,
	autoFocus = false,
}: DirectorySearchInputWithFilesystemProps) {
	const [state, dispatch] = useReducer(directorySearchReducer, initialDirectorySearchState)
	const { dropdownOpen, isFocused, recentPreview, selectedIndex } = state
	const inputRef = useRef<HTMLInputElement>(null)
	const didAutoFocusRef = useRef(false)
	const closeDropdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useMountEffect(() => () => {
		if (closeDropdownTimeoutRef.current) clearTimeout(closeDropdownTimeoutRef.current)
	})

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newValue = e.target.value
		onChange?.(newValue)

		// Filter recent directories based on input
		let recentObjs: RecentPreviewItem[] = []

		if (recentDirectories.length > 0) {
			if (newValue) {
				const recentSearchResults = fuzzySearch(
					recentDirectories.map((path) => ({ path })),
					newValue,
					{
						keys: ['path'],
						threshold: 0.3,
						includeMatches: true,
					},
				)

				recentObjs = recentSearchResults.map((result) => ({
					path: result.item.path,
					matches: result.matches,
				}))
			} else {
				recentObjs = recentDirectories.slice(0, 10).map((path) => ({
					path,
				}))
			}
		}

		dispatch({
			type: 'inputChanged',
			recentPreview: recentObjs,
			dropdownOpen: newValue.length > 0 || recentDirectories.length > 0,
		})
	}

	const handleFocus = () => {
		dispatch({ type: 'focus' })
		// Don't open dropdown on focus - only open when user starts typing
		// This allows Tab/Shift-Tab to navigate through the form without triggering autocomplete
	}

	const handleBlur = () => {
		dispatch({ type: 'blur' })
		if (closeDropdownTimeoutRef.current) clearTimeout(closeDropdownTimeoutRef.current)
		closeDropdownTimeoutRef.current = setTimeout(() => dispatch({ type: 'closeDropdown' }), 200)
		onBlur?.(value)
	}

	const handleSelectRecent = (path: string) => {
		onChange?.(path)
		dispatch({ type: 'closeDropdown' })
		inputRef.current?.focus()
		onBlur?.(path)
	}

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const totalItems = recentPreview.length

		if (e.key === 'ArrowDown') {
			e.preventDefault()
			// Open dropdown on arrow down if not open
			if (!dropdownOpen && (recentDirectories.length > 0 || value)) {
				dispatch({
					type: 'openWithRecent',
					recentPreview: recentDirectories.slice(0, 10).map((path) => ({ path })),
				})
			}
			if (totalItems > 0) {
				dispatch({ type: 'moveSelection', selectedIndex: (selectedIndex + 1) % totalItems })
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			if (totalItems > 0) {
				dispatch({ type: 'moveSelection', selectedIndex: (selectedIndex - 1 + totalItems) % totalItems })
			}
		} else if (e.key === 'Enter') {
			if (e.metaKey || e.ctrlKey) return
			e.preventDefault()
			e.stopPropagation()
			let confirmedPath = value
			if (dropdownOpen) {
				// Dropdown is open - select item if highlighted, otherwise accept typed value
				const item = recentPreview[selectedIndex]
				if (item) {
					confirmedPath = item.path
					handleSelectRecent(item.path)
				}
				dispatch({ type: 'closeDropdown' })
				if (onConfirm) {
					e.currentTarget.blur()
					onConfirm(confirmedPath)
				}
			} else if (onConfirm) {
				// Dropdown is closed and parent wants Enter-to-confirm
				e.currentTarget.blur()
				onConfirm(confirmedPath)
			} else {
				// Dropdown is closed - open it and populate recent directories
				dispatch({
					type: 'openWithRecent',
					recentPreview: recentDirectories.slice(0, 10).map((path) => ({ path })),
				})
			}
		} else if (e.key === 'Escape' && dropdownOpen) {
			// Only capture Escape when dropdown is open - close it and stop propagation
			// to prevent navigation away from the page
			e.preventDefault()
			e.stopPropagation()
			dispatch({ type: 'closeDropdown' })
		} else if (e.key === 'Tab' && dropdownOpen) {
			// Keep Tab inside the open dropdown; Escape closes it first.
			e.preventDefault()
		}
		// Tab/Shift-Tab when dropdown is closed are not intercepted - they navigate focus normally
	}

	const hasResults = recentPreview.length > 0

	const handleInputRef = (el: HTMLInputElement | null) => {
		inputRef.current = el
		if (typeof ref === 'function') {
			ref(el)
		} else if (ref) {
			ref.current = el
		}
		if (el && autoFocus && !didAutoFocusRef.current) {
			didAutoFocusRef.current = true
			setTimeout(() => el.focus(), 100)
		}
	}

	return (
		<div className="relative" style={style}>
			<Popover open={dropdownOpen && isFocused && hasResults} modal={false}>
				<PopoverAnchor>
					<Input
						id={id}
						ref={handleInputRef}
						aria-label={ariaLabel}
						className={cn('font-mono', className)}
						spellCheck={false}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						value={value}
						onFocus={handleFocus}
						onBlur={handleBlur}
						placeholder={placeholder}
						disabled={disabled}
					/>
				</PopoverAnchor>

				<PopoverContent
					onOpenAutoFocus={(e) => e.preventDefault()}
					onMouseDown={(e) => e.preventDefault()}
					side="bottom"
					align="start"
					avoidCollisions={false}
					className="w-[var(--radix-popover-trigger-width)] p-0"
				>
					<DirectorySearchResults
						recentPreview={recentPreview}
						selectedIndex={selectedIndex}
						onSelectRecent={handleSelectRecent}
					/>
				</PopoverContent>
			</Popover>
		</div>
	)
}
