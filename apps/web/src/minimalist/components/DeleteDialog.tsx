import { Dialog } from '@/minimalist/components/Dialog'
import { type DeleteTarget, useDelete } from '@/minimalist/lib/use-delete'

/**
 * The confirmation for a permanent delete. It spells out what goes and what stays, and offers only
 * Cancel and Delete; ⌘↵ confirms. Failures show inside the dialog.
 */
export function DeleteDialog({ target, onClose }: { target: DeleteTarget; onClose: () => void }) {
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
			<WhatGoesWhatStays target={target} />
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={onClose} disabled={deleter.pending}>
					Cancel
				</button>
				<button type="submit" className="btn danger" disabled={deleter.pending}>
					{deleter.pending ? 'Deleting…' : 'Delete task'}
				</button>
			</div>
		</Dialog>
	)
}

/** The boundary of a delete: everything in devflow goes, nothing on your hosts or GitHub does. */
function WhatGoesWhatStays({ target }: { target: DeleteTarget }) {
	switch (target.kind) {
		case 'task':
			return (
				<>
					<p>
						This permanently deletes the task with its sessions, conversations, comments and artifacts, and
						stops any agent still running on it. It can't be undone.
					</p>
					<p>Its worktree and branch on your hosts are kept. Nothing on GitHub changes.</p>
				</>
			)
	}
}
