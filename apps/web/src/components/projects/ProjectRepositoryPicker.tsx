import { normalizeRepositoryIdentity } from '@devflow/schemas/effect/project-workspace'
import { Button } from '@devflow/ui/components/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@devflow/ui/components/command'
import { Popover, PopoverContent, PopoverTrigger } from '@devflow/ui/components/popover'
import { Check, GitBranch, Search } from 'lucide-react'
import { useId, useState } from 'react'

import type { GitHubRepositoryOption } from '@/components/GitHubRepositoryPicker'
import { getOrgSettingsUrl } from '@/utils/artifact-links'

export interface ProjectGitHubRepository extends GitHubRepositoryOption {
	readonly defaultBranch: string
}

export interface ProjectRepositorySelection {
	readonly remoteUrl: string
	readonly defaultBranch: string
}

export function ProjectRepositoryPicker(props: Parameters<typeof ActiveProjectRepositoryPicker>[0]) {
	if (props.disabled)
		return (
			<Button
				type="button"
				variant="outline"
				role="combobox"
				aria-label="Find repositories"
				aria-expanded={false}
				disabled
				className="h-7 w-full justify-start px-2 text-xs"
			>
				Search repositories
			</Button>
		)
	return <ActiveProjectRepositoryPicker {...props} />
}

/** Finds a GitHub repository of the organization, or takes a pasted Git remote. */
function ActiveProjectRepositoryPicker({
	githubRepositories,
	githubRepositoriesLoading,
	githubError,
	githubConnected,
	stagedIdentities,
	onSelect,
	disabled,
	portalContainer,
}: {
	githubRepositories: ReadonlyArray<ProjectGitHubRepository>
	githubRepositoriesLoading: boolean
	githubError?: string
	githubConnected?: boolean
	stagedIdentities: ReadonlySet<string>
	onSelect: (repository: ProjectRepositorySelection) => void
	disabled: boolean
	portalContainer?: HTMLElement | null
}) {
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')
	const listId = useId()
	const query = search.trim()
	const githubMatches = githubRepositories.filter((repo) => repo.fullName.toLowerCase().includes(query.toLowerCase()))
	const pastedIdentity = normalizeRepositoryIdentity(query)
	const added = (url: string) => {
		const identity = normalizeRepositoryIdentity(url)
		return identity !== undefined && stagedIdentities.has(identity)
	}
	const select = (repository: ProjectRepositorySelection) => {
		onSelect(repository)
		setSearch('')
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					role="combobox"
					aria-label="Find repositories"
					aria-expanded={open}
					aria-controls={listId}
					disabled={disabled}
					className="h-7 w-full justify-start gap-2 px-2 text-xs normal-case tracking-normal font-normal text-muted-foreground"
				>
					<Search className="size-4" />
					Search GitHub repositories
				</Button>
			</PopoverTrigger>
			<PopoverContent
				portalContainer={portalContainer}
				align="start"
				collisionPadding={12}
				className="w-[max(60rem,var(--radix-popover-trigger-width))] max-w-[var(--radix-popover-content-available-width)] max-h-[var(--radix-popover-content-available-height)] overflow-hidden rounded-none p-0"
				onEscapeKeyDown={(event) => event.stopPropagation()}
			>
				<Command
					shouldFilter={false}
					className="h-auto rounded-none [&_[data-slot=command-input-wrapper]]:h-8 [&_[data-slot=command-input-wrapper]]:shrink-0 [&_[data-slot=command-item]]:rounded-none [&_[data-slot=command-item]]:py-1 [&_[data-slot=command-item]]:text-xs"
				>
					<CommandInput
						aria-label="Search repositories"
						className="h-8 text-xs"
						placeholder="organization/repository"
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList
						id={listId}
						className="min-h-0 max-h-[min(28rem,calc(var(--radix-popover-content-available-height)-2.5rem))] overscroll-contain"
					>
						<GitHubRepositoryResults
							githubRepositories={githubRepositories}
							githubMatches={githubMatches}
							githubRepositoriesLoading={githubRepositoriesLoading}
							githubError={githubError}
							githubConnected={githubConnected}
							added={added}
							select={select}
						/>
						{pastedIdentity && (
							<CommandGroup heading="Git remote">
								<CommandItem
									value="pasted-remote"
									disabled={added(query)}
									onSelect={() => select({ remoteUrl: query, defaultBranch: 'main' })}
								>
									<GitBranch />
									<span className="truncate">Add {pastedIdentity.split('/').slice(1).join('/')}</span>
								</CommandItem>
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

function repositoryStatus(repository: ProjectGitHubRepository, added: boolean) {
	if (repository.archived) return 'Archived'
	if (added) return 'Added'
	return repository.defaultBranch
}

function GitHubRepositoryResults({
	githubRepositories,
	githubMatches,
	githubRepositoriesLoading,
	githubError,
	githubConnected,
	added,
	select,
}: {
	githubRepositories: ReadonlyArray<ProjectGitHubRepository>
	githubMatches: ReadonlyArray<ProjectGitHubRepository>
	githubRepositoriesLoading: boolean
	githubError?: string
	githubConnected?: boolean
	added: (url: string) => boolean
	select: (repository: ProjectRepositorySelection) => void
}) {
	return (
		<CommandGroup heading="GitHub repositories">
			{!githubRepositoriesLoading && !githubError && !(githubConnected ?? githubRepositories.length > 0) && (
				<div className="space-y-1 p-2">
					<Button asChild size="sm" variant="outline">
						<a href={getOrgSettingsUrl()} target="_blank" rel="noopener noreferrer">
							Connect GitHub
						</a>
					</Button>
					<p className="text-xs text-muted-foreground">
						An organization admin can connect GitHub in cloud settings. Select the same organization there.
					</p>
				</div>
			)}
			{githubRepositoriesLoading && (
				<p role="status" className="px-2 py-2 text-xs text-muted-foreground">
					Loading connected GitHub repositories...
				</p>
			)}
			{githubError && (
				<p role="alert" className="px-2 py-2 text-xs text-destructive">
					{githubError}
				</p>
			)}
			{githubMatches.map((repository) => {
				const remoteUrl = `https://github.com/${repository.fullName}.git`
				return (
					<CommandItem
						key={`${repository.connectionId}:${repository.repositoryId}`}
						value={`github:${repository.connectionId}:${repository.repositoryId}`}
						disabled={repository.archived || added(remoteUrl)}
						onSelect={() =>
							select({
								remoteUrl,
								defaultBranch: repository.defaultBranch,
							})
						}
					>
						{added(remoteUrl) ? <Check /> : <GitBranch />}
						<span className="min-w-0 flex-1 truncate">{repository.fullName}</span>
						<span className="text-xs">{repositoryStatus(repository, added(remoteUrl))}</span>
					</CommandItem>
				)
			})}
			{!githubRepositoriesLoading && !githubError && githubMatches.length === 0 && (
				<p className="px-2 py-2 text-xs text-muted-foreground">
					{githubRepositories.length === 0
						? 'No GitHub repositories available for this organization.'
						: 'No matching GitHub repositories.'}
				</p>
			)}
		</CommandGroup>
	)
}
