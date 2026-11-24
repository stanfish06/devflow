import { useQuery } from '@tanstack/react-query'
import { useDebounce } from '@uidotdev/usehooks'

import { useGitHubIssuePreviewSource } from '@/hooks/useGitHubIssuePreviewSource'
import { generatePrefixedTaskSlug } from '@/lib/task-slug'
import { useApi } from '@/orpc/client'

export type GitHubRepository = {
	connectionId: string
	repositoryId: string
	fullName: string
	accountLogin: string
	private: boolean
	archived: boolean
}

/** A GitHub issue the task starts from; the server imports it into the task's artifacts. */
export type Ticket = {
	provider: 'github'
	ticketId: string
	name: string
	slug: string
	url: string | null
	githubRepository: GitHubRepository
}

/**
 * Whether GitHub issues can be attached, or GitHub needs connecting first. Any installation
 * counts; the dialog explains one that can't read issues. Until the answer is in, it reads as
 * connected so the menu doesn't flicker.
 */
export function useGitHubConnected(): boolean {
	const { queryClient: api } = useApi()
	const github = useQuery(
		api.integrations.github.listConnections.queryOptions({ input: {}, context: { silent: true } }),
	)
	return github.data ? github.data.connections.length > 0 : true
}

type Preview = { ticket: Ticket | null; error: string | null; loading: boolean }

/**
 * A GitHub issue by number in the chosen repository, or by link. The project's repository is
 * the first choice; a pasted link picks its own repository and leaves just the number.
 */
export function useGitHubTicketPreview({
	input,
	setInput,
	projectRepository,
}: {
	input: string
	setInput: (value: string) => void
	/** `owner/name` of the project's repository, when the task starts in a project. */
	projectRepository: string | null
}) {
	const github = useGitHubIssuePreviewSource({
		enabled: true,
		issueInput: input,
		setIssueInput: setInput,
		preferredRepositoryFullName: projectRepository,
	})
	const settled = useDebounce(input, 300) === input
	const repository = github.selectedRepository
	const preview: Preview = {
		ticket: github.preview && repository ? githubTicket(github.preview, repository) : null,
		error: github.isLoadingRepositories
			? null
			: (github.disabledReason ?? (input.trim() && settled ? github.inputError : null)),
		loading: github.isLoadingRepositories || github.isFetchingPreview || (input.trim() !== '' && !settled),
	}
	return {
		preview,
		repositories: github.repositories.filter((option) => !option.archived),
		repository,
		selectRepository: github.selectRepository,
		change: github.changeIssueInput,
	}
}

function githubTicket(
	issue: { issueNumber: number; title: string; url: string; repository: { fullName: string } },
	repository: GitHubRepository,
): Ticket {
	const { fullName } = issue.repository
	return {
		provider: 'github',
		ticketId: String(issue.issueNumber),
		name: `[${fullName}#${issue.issueNumber}] ${issue.title}`,
		slug: generatePrefixedTaskSlug(
			`${fullName.replace('/', '-')}-${issue.issueNumber}-`.toLowerCase(),
			issue.title,
		),
		url: issue.url,
		githubRepository: repository,
	}
}

/** `owner/name` for a GitHub project repository, from its `github.com/owner/name` identity. */
export function githubFullName(repositoryIdentity: string | undefined): string | null {
	return repositoryIdentity?.startsWith('github.com/') ? repositoryIdentity.slice('github.com/'.length) : null
}

/** The task fields that tell the server which issue to import. */
export function ticketFields(ticket: Ticket | null) {
	if (!ticket) return {}
	const repository = ticket.githubRepository
	return {
		ticketProvider: ticket.provider,
		ticketId: ticket.ticketId,
		ticketUrl: ticket.url ?? undefined,
		githubConnectionId: repository.connectionId,
		ticketRepositoryId: repository.repositoryId,
		ticketRepositoryFullName: repository.fullName,
	}
}

/** How the issue reads in copy: `acme/app#42`. */
export function ticketLabel(ticket: Ticket): string {
	return `${ticket.githubRepository.fullName}#${ticket.ticketId}`
}

/** The server's file name for the imported issue, so the first prompt can point at it before it exists. */
export function ticketArtifactFileName(ticket: Ticket): string {
	return `${ticket.githubRepository.fullName}-${ticket.ticketId}`.replaceAll(/[^A-Za-z0-9._-]+/g, '-') + '.md'
}

/** The first prompt: what you typed, then a pointer to the imported issue so the agent reads it. */
export function withTicket(text: string, slug: string, ticket: Ticket | null): string {
	if (!ticket) return text
	const reference = `@.devflow/tasks/${slug}/${ticketArtifactFileName(ticket)}`
	return text.trim() ? `${text}\n\nSee ${reference}` : `Work on ${ticketLabel(ticket)}. See ${reference}`
}
