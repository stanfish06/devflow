import { useId, useState } from 'react'

import { Dialog } from '@/minimalist/components/Dialog'
import {
	type DeleteTarget,
	type ProjectDeletePreview,
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
	const inputId = useId()
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
			<label className="lbl" htmlFor={inputId}>
				Type <b>{target.name}</b> to confirm
			</label>
			<input
				id={inputId}
				aria-label="Type to confirm"
				placeholder={target.name}
				value={typed}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => setTyped(event.target.value)}
			/>
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
