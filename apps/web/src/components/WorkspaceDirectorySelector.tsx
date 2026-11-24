import { useHotkeys } from '@devflow/hotkeys'
import { Button } from '@devflow/ui/components/button'
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@devflow/ui/components/command'
import { Input } from '@devflow/ui/components/input'
import { Popover, PopoverAnchor, PopoverContent } from '@devflow/ui/components/popover'
import { cn } from '@devflow/ui/lib/utils'
import { Check, ChevronsUpDown, Folder, FolderTree, Pencil } from 'lucide-react'
import type React from 'react'
import { useId, useMemo, useReducer, useRef } from 'react'

import { HOTKEY_SCOPES } from '@/hooks/hotkeys/scopes'
import type { WorkspaceLaunchChoice } from '@/lib/workspace-launch'

import { HotkeyScopeBoundary } from './HotkeyScopeBoundary'

interface WorkspaceDirectorySelectorProps {
	/** Current working-directory value; matched against choice paths for the checked state */
	value?: string
	onChange?: (path: string) => void
	/** Fired with the committed path on selection/close */
	onBlur?: (path: string) => void
	choices: WorkspaceLaunchChoice[]
	placeholder?: string
	className?: string
	disabled?: boolean
	/** The selected path is the planned task worktree and does not exist on this host yet. */
	pendingWorkspaceSetup?: boolean
}

function choiceTitle(choice: WorkspaceLaunchChoice): string {
	return choice.description ? `${choice.path} — ${choice.description}` : choice.path
}

interface SelectorState {
	editing: boolean
	searchText: string
	edited: boolean
	cmdkValue?: string
}

type SelectorAction =
	| { type: 'startEditing'; value: string }
	| { type: 'close' }
	| { type: 'inputChanged'; value: string }
	| { type: 'setCmdkValue'; value?: string }

const initialSelectorState: SelectorState = {
	editing: false,
	searchText: '',
	edited: false,
	cmdkValue: undefined,
}

function selectorReducer(state: SelectorState, action: SelectorAction): SelectorState {
	switch (action.type) {
		case 'startEditing':
			return { ...state, editing: true, searchText: action.value, edited: false, cmdkValue: undefined }
		case 'close':
			return { ...state, editing: false }
		case 'inputChanged':
			return { ...state, searchText: action.value, edited: true, cmdkValue: undefined }
		case 'setCmdkValue':
			return { ...state, cmdkValue: action.value }
	}
}

function DirectoryInput({
	inputRef,
	listboxId,
	searchText,
	onChange,
	onKeyDown,
	onBlur,
}: {
	inputRef: (el: HTMLInputElement | null) => void
	listboxId: string
	searchText: string
	onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
	onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
	onBlur: () => void
}) {
	return (
		<Input
			ref={inputRef}
			role="combobox"
			aria-expanded={true}
			aria-controls={listboxId}
			spellCheck={false}
			className="font-mono"
			value={searchText}
			placeholder="Enter a working directory..."
			onChange={onChange}
			onKeyDown={onKeyDown}
			onBlur={onBlur}
		/>
	)
}

function DirectoryButton({
	listboxId,
	disabled,
	selectedChoice,
	value,
	placeholder,
	onClick,
	pendingWorkspaceSetup,
}: {
	listboxId: string
	disabled: boolean
	selectedChoice?: WorkspaceLaunchChoice
	value?: string
	placeholder: string
	onClick: () => void
	pendingWorkspaceSetup: boolean
}) {
	return (
		<Button
			type="button"
			variant="outline"
			role="combobox"
			aria-expanded={false}
			aria-controls={listboxId}
			disabled={disabled}
			title={
				pendingWorkspaceSetup
					? 'This task worktree will be created after you locate the repositories.'
					: selectedChoice
						? choiceTitle(selectedChoice)
						: value || undefined
			}
			onClick={onClick}
			className={cn(
				'w-full justify-between font-normal normal-case tracking-normal group',
				!selectedChoice && !value && 'text-muted-foreground',
			)}
		>
			<DirectoryButtonLabel
				selectedChoice={selectedChoice}
				value={value}
				placeholder={placeholder}
				pendingWorkspaceSetup={pendingWorkspaceSetup}
			/>
			<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 stroke-accent group-hover:stroke-background" />
		</Button>
	)
}

function DirectoryButtonLabel({
	selectedChoice,
	value,
	placeholder,
	pendingWorkspaceSetup,
}: {
	selectedChoice?: WorkspaceLaunchChoice
	value?: string
	placeholder: string
	pendingWorkspaceSetup: boolean
}) {
	if (selectedChoice) {
		return (
			<span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
				{selectedChoice.kind === 'root' ? (
					<FolderTree className="h-3.5 w-3.5 shrink-0" />
				) : (
					<Folder className="h-3.5 w-3.5 shrink-0" />
				)}
				<span className="truncate">{selectedChoice.label}</span>
				{selectedChoice.primary && (
					<span className="shrink-0 text-muted-foreground group-hover:text-background">· primary</span>
				)}
				{pendingWorkspaceSetup && (
					<span className="shrink-0 text-warning group-hover:text-background">· created after setup</span>
				)}
			</span>
		)
	}
	if (value) {
		return (
			<span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
				<Pencil className="h-3.5 w-3.5 shrink-0" />
				<span className="truncate">{value}</span>
			</span>
		)
	}
	return <span className="truncate">{placeholder}</span>
}

function DirectoryOptions({
	listboxId,
	visibleChoices,
	effectiveCmdkValue,
	customChecked,
	value,
	noResults,
	onCmdkValueChange,
	onSelectChoice,
	onSelectCustom,
}: {
	listboxId: string
	visibleChoices: WorkspaceLaunchChoice[]
	effectiveCmdkValue: string
	customChecked: boolean
	value?: string
	noResults: boolean
	onCmdkValueChange: (value: string) => void
	onSelectChoice: (choice: WorkspaceLaunchChoice) => void
	onSelectCustom: () => void
}) {
	return (
		<Command shouldFilter={false} value={effectiveCmdkValue} onValueChange={onCmdkValueChange}>
			<CommandList id={listboxId}>
				<WorkspaceChoiceOptions choices={visibleChoices} value={value} onSelectChoice={onSelectChoice} />
				{noResults && (
					<div className="py-2 text-center text-sm text-muted-foreground">No matching directories</div>
				)}
				<CommandSeparator />
				<CommandGroup>
					<CommandItem value="custom:" onSelect={onSelectCustom}>
						<Check className={cn('mr-2 h-4 w-4', customChecked ? 'opacity-100' : 'opacity-0')} />
						<Pencil className="mr-1.5 h-3.5 w-3.5 shrink-0" />
						<span className="text-xs">Custom</span>
						{customChecked && value && (
							<span className="ml-auto max-w-[55%] truncate pl-2 font-mono text-xs text-muted-foreground">
								{value}
							</span>
						)}
					</CommandItem>
				</CommandGroup>
			</CommandList>
		</Command>
	)
}

function WorkspaceChoiceOptions({
	choices,
	value,
	onSelectChoice,
}: {
	choices: WorkspaceLaunchChoice[]
	value?: string
	onSelectChoice: (choice: WorkspaceLaunchChoice) => void
}) {
	if (choices.length === 0) return null
	return (
		<CommandGroup>
			{choices.map((choice) => (
				<CommandItem
					key={choice.path}
					className="group"
					value={`choice:${choice.path}`}
					title={choiceTitle(choice)}
					onSelect={() => onSelectChoice(choice)}
				>
					<Check className={cn('mr-2 h-4 w-4', value === choice.path ? 'opacity-100' : 'opacity-0')} />
					{choice.kind === 'root' ? (
						<FolderTree className="mr-1.5 h-3.5 w-3.5 shrink-0" />
					) : (
						<Folder className="mr-1.5 h-3.5 w-3.5 shrink-0" />
					)}
					<span className="truncate font-mono text-xs">{choice.label}</span>
					{choice.primary && (
						<span className="ml-1.5 shrink-0 text-xs text-muted-foreground group-data-[selected=true]:text-background">
							· primary
						</span>
					)}
					{choice.description && (
						<span className="ml-auto max-w-[40%] truncate pl-2 text-xs text-muted-foreground">
							{choice.description}
						</span>
					)}
				</CommandItem>
			))}
		</CommandGroup>
	)
}

/**
 * Working-directory selector for multi-repo workspace tasks. Closed, it's a
 * combobox-style button showing the selected workspace launch location
 * (workspace root / a repo, primary flagged) or a custom path. Clicking it
 * swaps the button for an editable input pre-filled with the full path —
 * the old free-text directory field — anchored to a dropdown of the
 * workspace locations plus a "Custom" row. Edits flow into the form live
 * (moving the check to Custom), with arrow/Enter/Escape keyboard handling.
 */
export function WorkspaceDirectorySelector({
	value,
	onChange,
	onBlur,
	choices,
	placeholder = 'Select a directory to work in...',
	className,
	disabled = false,
	pendingWorkspaceSetup = false,
}: WorkspaceDirectorySelectorProps) {
	const [state, dispatch] = useReducer(selectorReducer, initialSelectorState)
	const { editing, searchText, edited, cmdkValue } = state
	const listboxId = useId()
	const inputRef = useRef<HTMLInputElement>(null)

	const selectedChoice = useMemo(() => choices.find((choice) => choice.path === value), [choices, value])
	const customChecked = !selectedChoice && Boolean(value)

	// While editing, narrow the workspace locations to ones matching the text.
	const visibleChoices = useMemo(() => {
		if (!edited) return choices
		const needle = searchText.trim().toLowerCase()
		if (!needle) return choices
		return choices.filter(
			(choice) => choice.label.toLowerCase().includes(needle) || choice.path.toLowerCase().includes(needle),
		)
	}, [choices, edited, searchText])

	// cmdk item values in rendered order: workspace locations, then Custom. Drives arrow-key
	// navigation and the derived default highlight.
	const orderedItemValues = useMemo(
		() => [...visibleChoices.map((choice) => `choice:${choice.path}`), 'custom:'],
		[visibleChoices],
	)
	const fallbackCmdkValue = edited
		? (orderedItemValues[0] ?? 'custom:')
		: selectedChoice
			? `choice:${selectedChoice.path}`
			: 'custom:'
	// The controlled cmdk selection: explicit hover/arrow value when set (and
	// still rendered), else the derived default.
	const effectiveCmdkValue = cmdkValue && orderedItemValues.includes(cmdkValue) ? cmdkValue : fallbackCmdkValue

	const startEditing = () => {
		dispatch({ type: 'startEditing', value: value ?? '' })
	}

	const commitAndClose = (path: string) => {
		dispatch({ type: 'close' })
		onBlur?.(path)
	}

	const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const next = event.target.value
		dispatch({ type: 'inputChanged', value: next })
		onChange?.(next)
	}

	const handleSelectChoice = (choice: WorkspaceLaunchChoice) => {
		onChange?.(choice.path)
		commitAndClose(choice.path)
	}

	// Custom keeps the editor open: the input already holds the current path
	// (pre-filled on open, live-synced while typing), so return focus to it
	// with the whole path selected — no blinking caret, and typing replaces
	// the path outright. The check moves to Custom once the text deviates
	// from a workspace location.
	const handleSelectCustom = () => {
		const input = inputRef.current
		if (input) {
			input.focus()
			input.select()
		}
	}

	// Activate a dropdown row by its cmdk value (Enter key). Custom accepts the typed path
	// as-is, the keyboard counterpart of clicking away.
	const selectCmdkValue = (itemValue: string) => {
		if (itemValue.startsWith('choice:')) {
			const choicePath = itemValue.slice('choice:'.length)
			const choice = choices.find((c) => c.path === choicePath)
			if (choice) {
				handleSelectChoice(choice)
				return
			}
		}
		commitAndClose(searchText)
	}

	const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			const currentIndex = orderedItemValues.indexOf(effectiveCmdkValue)
			const delta = e.key === 'ArrowDown' ? 1 : -1
			const nextIndex = (currentIndex + delta + orderedItemValues.length) % orderedItemValues.length
			dispatch({ type: 'setCmdkValue', value: orderedItemValues[nextIndex] })
		} else if (e.key === 'Enter') {
			e.preventDefault()
			selectCmdkValue(effectiveCmdkValue)
		} else if (e.key === 'Escape') {
			// Close the editor without letting the page-level Escape handler run.
			e.preventDefault()
			e.stopPropagation()
			commitAndClose(searchText)
		}
	}

	// Escape via the scoped hotkey too (mirrors TaskSelector), in case focus
	// has left the input while the editor is open.
	useHotkeys(
		'Escape',
		(e) => {
			e.preventDefault()
			commitAndClose(searchText)
		},
		{
			scopes: [HOTKEY_SCOPES.WORKSPACE_DIRECTORY_SELECTOR],
			enabled: editing,
			enableOnFormTags: true,
		},
	)

	const noResults = edited && visibleChoices.length === 0

	return (
		<HotkeyScopeBoundary
			scope={HOTKEY_SCOPES.WORKSPACE_DIRECTORY_SELECTOR}
			isActive={editing}
			rootScopeDisabled={false}
			componentName="WorkspaceDirectorySelector"
		>
			<div className={className}>
				<Popover open={editing} modal={false}>
					<PopoverAnchor>
						{editing ? (
							<DirectoryInput
								inputRef={(el) => {
									inputRef.current = el
									el?.focus()
								}}
								listboxId={listboxId}
								searchText={searchText}
								onChange={handleInputChange}
								onKeyDown={handleInputKeyDown}
								onBlur={() => commitAndClose(searchText)}
							/>
						) : (
							<DirectoryButton
								listboxId={listboxId}
								disabled={disabled}
								selectedChoice={selectedChoice}
								value={value}
								placeholder={placeholder}
								onClick={startEditing}
								pendingWorkspaceSetup={pendingWorkspaceSetup}
							/>
						)}
					</PopoverAnchor>
					<PopoverContent
						onOpenAutoFocus={(e) => e.preventDefault()}
						onMouseDown={(e) => e.preventDefault()}
						side="bottom"
						align="start"
						avoidCollisions={false}
						className="w-[var(--radix-popover-trigger-width)] p-0"
					>
						<DirectoryOptions
							listboxId={listboxId}
							visibleChoices={visibleChoices}
							effectiveCmdkValue={effectiveCmdkValue}
							customChecked={customChecked}
							value={value}
							noResults={noResults}
							onCmdkValueChange={(nextValue) => dispatch({ type: 'setCmdkValue', value: nextValue })}
							onSelectChoice={handleSelectChoice}
							onSelectCustom={handleSelectCustom}
						/>
					</PopoverContent>
				</Popover>
			</div>
		</HotkeyScopeBoundary>
	)
}
