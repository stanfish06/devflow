import { useId, useState } from 'react'

import { Dialog } from '@/minimalist/components/Dialog'
import {
	type ArchivedTasksDeletePreview,
	type DeleteTarget,
	type ProjectDeletePreview,
	taskCount,
	useArchivedTasksDeletePreview,
	useDelete,
	useProjectDeletePreview,
} from '@/minimalist/lib/use-delete'

/**
 * The confirmation for a permanent delete. It spells out what goes and what stays, and offers only
 * Cancel and Delete; ⌘↵ confirms. Failures show inside the dialog.
 */
export function DeleteDialog({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
	switch (target.kind) {
		case 'task':
			return <TaskDeleteDialog target={target} onClose={onClose} />
		case 'project':
			return <ProjectDeleteDialog target={target} onClose={onClose} />
		case 'archived-tasks':
			return <ArchivedTasksDeleteDialog onClose={onClose} />
	}
}

function TaskDeleteDialog({
	target,
	onClose,
}: {
	target: Extract<DeleteTarget, { kind: 'task' }>
	onClose: () => void
}) {
	const deleter = useDelete()
	const submit = () => {
		if (deleter.pending) return
		void deleter.remove(target).then((outcome) => {
			if (outcome === 'deleted') onClose()
		})
	}
	return (
		<Dialog
			title={`Delete “${target.title || 'Untitled task'}”?`}
			busy={deleter.pending}
			error={deleter.error}
			onClose={onClose}
			onSubmit={submit}
		>
			<p>
				This permanently deletes the task with its sessions, conversations, comments and artifacts, and stops
				any agent still running on it. It can't be undone.
			</p>
			<p>Its worktree and branch on your hosts are kept. Nothing on GitHub changes.</p>
			<DeleteActions label="Delete task" pending={deleter.pending} disabled={false} onCancel={onClose} />
		</Dialog>
	)
}

/**
 * A project takes all its tasks with it, so the dialog shows the server's count (teammates' tasks
 * included) and stays inert, ⌘↵ too, until the project's name is typed exactly. If the count moves
 * before the delete lands, nothing is deleted and the dialog counts again.
 */
function ProjectDeleteDialog({
	target,
	onClose,
}: {
	target: Extract<DeleteTarget, { kind: 'project' }>
	onClose: () => void
}) {
	const deleter = useDelete()
	const preview = useProjectDeletePreview(target.projectId)
	const [typed, setTyped] = useState('')
	const counted = preview.isFetching ? undefined : preview.data
	const ready = counted !== undefined && typed === target.name && !deleter.pending
	const submit = () => {
		if (!ready) return
		void deleter.remove(target, counted.taskCount).then((outcome) => {
			if (outcome === 'deleted') onClose()
			else if (outcome === 'count-changed') void preview.refetch()
		})
	}
	const countError =
		preview.isError && !preview.isFetching ? `Could not count ${target.name}'s tasks. Try again.` : null
	return (
		<Dialog
			title={`Delete “${target.name}”?`}
			busy={deleter.pending}
			error={deleter.error ?? countError}
			onClose={onClose}
			onSubmit={submit}
		>
			<ProjectLoss counted={counted} />
			<p>Checkouts, worktrees and branches on your hosts are kept. Nothing on GitHub changes.</p>
			<TypeToConfirm phrase={target.name} value={typed} onChange={setTyped} />
			<DeleteActions label="Delete project" pending={deleter.pending} disabled={!ready} onCancel={onClose} />
		</Dialog>
	)
}

/** "This also deletes 12 tasks (3 by others)", once the server has counted them. */
function ProjectLoss({ counted }: { counted: ProjectDeletePreview | undefined }) {
	if (counted === undefined) return <p>This permanently deletes the project and all of its tasks. Counting them…</p>
	if (counted.taskCount === 0)
		return <p>This permanently deletes the project. It has no tasks. It can't be undone.</p>
	const others = counted.otherPeoplesTaskCount
	return (
		<p>
			This permanently deletes the project. This also deletes{' '}
			<b>{counted.taskCount === 1 ? '1 task' : `${counted.taskCount} tasks`}</b>
			{others > 0 ? ` (${others} by ${others === 1 ? 'someone else' : 'others'})` : ''}, with their sessions,
			conversations, comments and artifacts, and stops any agent still running on them. It can't be undone.
		</p>
	)
}

/**
 * Every archived task you own, in one go: the most destructive action in the app. The dialog states
 * the server's exact count and the shared archived tasks it skips, and stays inert, ⌘↵ too, until
 * `delete N tasks` is typed for that count. If the count moves first, nothing is deleted, the dialog
 * counts again, and the new phrase has to be typed.
 */
function ArchivedTasksDeleteDialog({ onClose }: { onClose: () => void }) {
	const deleter = useDelete()
	const preview = useArchivedTasksDeletePreview()
	const [typed, setTyped] = useState('')
	const counted = preview.isFetching ? undefined : preview.data
	// Nothing to type, or delete, until the server has counted at least one task.
	const deletable = counted !== undefined && counted.deletableCount > 0 ? counted.deletableCount : null
	const phrase = deletable === null ? null : `delete ${taskCount(deletable)}`
	const ready = deletable !== null && typed === phrase && !deleter.pending
	const submit = () => {
		if (!ready) return
		void deleter.remove({ kind: 'archived-tasks' }, deletable).then((outcome) => {
			if (outcome === 'deleted') onClose()
			else if (outcome === 'count-changed') void preview.refetch()
		})
	}
	const countError = preview.isError && !preview.isFetching ? 'Could not count your archived tasks. Try again.' : null
	return (
		<Dialog
			title={
				deletable === null
					? 'Delete all archived tasks?'
					: `Delete ${deletable === 1 ? '1 archived task' : `${deletable} archived tasks`}?`
			}
			busy={deleter.pending}
			error={deleter.error ?? countError}
			onClose={onClose}
			onSubmit={submit}
		>
			<ArchivedTasksLoss counted={counted} />
			<p>Worktrees and branches on your hosts are kept. Nothing on GitHub changes.</p>
			{phrase === null ? null : <TypeToConfirm phrase={phrase} value={typed} onChange={setTyped} />}
			<DeleteActions
				label={deletable === null ? 'Delete tasks' : `Delete ${taskCount(deletable)}`}
				pending={deleter.pending}
				disabled={!ready}
				onCancel={onClose}
			/>
		</Dialog>
	)
}

/** "…every archived task you own… 1 archived task shared with you is skipped." */
function ArchivedTasksLoss({ counted }: { counted: ArchivedTasksDeletePreview | undefined }) {
	if (counted === undefined) return <p>This permanently deletes every archived task you own. Counting them…</p>
	const skipped = counted.skippedSharedCount
	const skippedCopy =
		skipped === 0
			? ''
			: skipped === 1
				? ' 1 archived task shared with you is skipped.'
				: ` ${skipped} archived tasks shared with you are skipped.`
	if (counted.deletableCount === 0) return <p>You have no archived tasks of your own to delete.{skippedCopy}</p>
	return (
		<p>
			This permanently deletes every archived task you own, <b>{taskCount(counted.deletableCount)}</b>, with their
			sessions, conversations, comments and artifacts. It can't be undone.{skippedCopy}
		</p>
	)
}

/** The typed-phrase gate: Delete and ⌘↵ stay inert until `phrase` is typed exactly. */
function TypeToConfirm({
	phrase,
	value,
	onChange,
}: {
	phrase: string
	value: string
	onChange: (value: string) => void
}) {
	const inputId = useId()
	return (
		<>
			<label className="lbl" htmlFor={inputId}>
				Type <b>{phrase}</b> to confirm
			</label>
			<input
				id={inputId}
				aria-label="Type to confirm"
				placeholder={phrase}
				value={value}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => onChange(event.target.value)}
			/>
		</>
	)
}

function DeleteActions({
	label,
	pending,
	disabled,
	onCancel,
}: {
	label: string
	pending: boolean
	disabled: boolean
	onCancel: () => void
}) {
	return (
		<div className="dialog-actions">
			<button type="button" className="btn" onClick={onCancel} disabled={pending}>
				Cancel
			</button>
			<button type="submit" className="btn danger" disabled={pending || disabled}>
				{pending ? 'Deleting…' : label}
			</button>
		</div>
	)
}
