import { type ReactNode, useState } from 'react'

import { Dialog } from '@/minimalist/components/Dialog'
import { type Ticket, useGitHubTicketPreview } from '@/minimalist/lib/tickets'

type Props = {
	/** `owner/name` of the project's repository, which lookups start in. */
	projectRepository: string | null
	onAttach: (ticket: Ticket) => void
	onClose: () => void
}

/**
 * Asks for a GitHub issue number or link and shows the issue's title before you attach it. A
 * pasted link brings its own repository; otherwise the project's is first.
 */
export function IssueDialog({ projectRepository, onAttach, onClose }: Props) {
	const [value, setValue] = useState('')
	const github = useGitHubTicketPreview({ input: value, setInput: setValue, projectRepository })
	const key = (repository: { connectionId: string; repositoryId: string }) =>
		`${repository.connectionId}:${repository.repositoryId}`
	return (
		<IssueForm
			placeholder="Issue number or a github.com link"
			value={value}
			onChange={github.change}
			preview={github.preview}
			onAttach={onAttach}
			onClose={onClose}
		>
			{github.repositories.length > 1 && github.repository ? (
				<select
					className="select repo-select"
					aria-label="Repository"
					value={key(github.repository)}
					onChange={(event) => {
						const next = github.repositories.find((repository) => key(repository) === event.target.value)
						if (next) github.selectRepository(next)
					}}
				>
					{github.repositories.map((repository) => (
						<option key={key(repository)} value={key(repository)}>
							{repository.fullName}
						</option>
					))}
				</select>
			) : null}
		</IssueForm>
	)
}

function IssueForm({
	placeholder,
	value,
	onChange,
	preview,
	onAttach,
	onClose,
	children,
}: {
	placeholder: string
	value: string
	onChange: (value: string) => void
	preview: { ticket: Ticket | null; error: string | null; loading: boolean }
	onAttach: (ticket: Ticket) => void
	onClose: () => void
	/** Anything the lookup needs before the ID, such as the repository. */
	children?: ReactNode
}) {
	return (
		<Dialog
			title="Start from a GitHub issue"
			description="The agent reads the issue when the task starts."
			onClose={onClose}
			onSubmit={() => {
				if (!preview.ticket) return
				onAttach(preview.ticket)
				onClose()
			}}
		>
			{children}
			<input
				aria-label="GitHub issue number or link"
				placeholder={placeholder}
				autoFocus
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<div className={`issue-preview${preview.error ? ' error' : ''}`} aria-live="polite">
				{preview.ticket?.name ?? preview.error ?? (preview.loading && value.trim() ? 'Looking up…' : null)}
			</div>
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={onClose}>
					Cancel
				</button>
				<button type="submit" className="btn primary" disabled={!preview.ticket}>
					Attach
				</button>
			</div>
		</Dialog>
	)
}
