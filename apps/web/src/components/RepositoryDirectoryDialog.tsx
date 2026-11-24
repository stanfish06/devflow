import {
	deriveRepositoryPlacement,
	joinPortablePath,
	normalizePortablePath,
} from '@devflow/db/utils/repository-directory'
import { useHotkeys } from '@devflow/hotkeys'
import type { WorkspaceSpec } from '@devflow/schemas/effect/workspace'
import { Button } from '@devflow/ui/components/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@devflow/ui/components/dialog'
import { Input } from '@devflow/ui/components/input'
import { KeyboardShortcut } from '@devflow/ui/components/keyboard-shortcut'
import { FolderGit2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { HotkeyScopeBoundary } from '@/components/HotkeyScopeBoundary'
import { HOTKEY_SCOPES } from '@/hooks/hotkeys/scopes'

export interface RepositoryDirectoryDialogProps {
	open: boolean
	workspaceSpec: WorkspaceSpec
	hostName?: string | null
	initialDirectory?: string
	onContinue: (repositoryDirectory: string) => void
	onCancel: () => void
}

function repositoryName(path: string): string {
	return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}

export function RepositoryDirectoryDialog({
	open,
	workspaceSpec,
	hostName,
	initialDirectory = '',
	onContinue,
	onCancel,
}: RepositoryDirectoryDialogProps) {
	const [repositoryDirectory, setRepositoryDirectory] = useState(initialDirectory)
	const placement = useMemo(() => deriveRepositoryPlacement(workspaceSpec), [workspaceSpec])
	const isSingleRepository = workspaceSpec.repos.length === 1
	const normalizedDirectory = useMemo(() => {
		try {
			return repositoryDirectory.trim() ? normalizePortablePath(repositoryDirectory) : ''
		} catch {
			return ''
		}
	}, [repositoryDirectory])
	const expectedPaths = useMemo(() => {
		if (!normalizedDirectory) return placement.repositories.map(() => '')
		if (isSingleRepository) {
			const repository = placement.repositories[0]
			if (!repository) return ['']
			const expectedName = repositoryName(repository.creatorPath)
			const selectedName = repositoryName(normalizedDirectory)
			return [
				selectedName === expectedName
					? normalizedDirectory
					: joinPortablePath(normalizedDirectory, expectedName),
			]
		}
		return placement.repositories.map((repository) =>
			joinPortablePath(normalizedDirectory, repository.relativePath),
		)
	}, [isSingleRepository, normalizedDirectory, placement.repositories])
	const continueDisabled = !normalizedDirectory

	const handleContinue = useCallback(() => {
		if (!continueDisabled) onContinue(normalizedDirectory)
	}, [continueDisabled, normalizedDirectory, onContinue])
	const handleCancel = useCallback(() => onCancel(), [onCancel])

	useHotkeys(
		'mod+enter',
		(event) => {
			event.preventDefault()
			event.stopPropagation()
			handleContinue()
		},
		{
			enabled: open && !continueDisabled,
			enableOnFormTags: true,
			scopes: [HOTKEY_SCOPES.REPOSITORY_DIRECTORY_DIALOG],
		},
		[open, continueDisabled, handleContinue],
	)

	useHotkeys(
		'escape',
		(event) => {
			event.preventDefault()
			event.stopPropagation()
			handleCancel()
		},
		{
			enabled: open,
			enableOnFormTags: true,
			scopes: [HOTKEY_SCOPES.REPOSITORY_DIRECTORY_DIALOG],
		},
		[open, handleCancel],
	)

	return (
		<HotkeyScopeBoundary
			scope={HOTKEY_SCOPES.REPOSITORY_DIRECTORY_DIALOG}
			isActive={open}
			rootScopeDisabled
			componentName="RepositoryDirectoryDialog"
		>
			<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleCancel()}>
				<DialogContent
					className="overflow-hidden"
					style={{ width: 'min(92vw, 64rem)', maxWidth: 'min(92vw, 64rem)' }}
					onEscapeKeyDown={(event) => event.preventDefault()}
					onPointerDownOutside={(event) => event.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<FolderGit2 className="h-4 w-4" />
							Locate this task&apos;s {isSingleRepository ? 'repository' : 'repositories'}
						</DialogTitle>
						<DialogDescription>
							This task has not been set up on {hostName || 'this host'} yet.{' '}
							{isSingleRepository
								? 'Choose where the existing repository lives so we can create the task folder and start the session.'
								: 'Choose the folder containing the existing repositories so we can create the task folders and start the session.'}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-2">
						<label htmlFor="repository-directory" className="text-xs font-medium uppercase tracking-wider">
							{isSingleRepository ? 'Repository or containing folder' : 'Folder containing repositories'}
						</label>
						<p className="text-xs text-muted-foreground">
							{isSingleRepository
								? 'Choose the existing repository itself or the folder directly containing it.'
								: 'Choose the shared folder containing the complete repository layout below. Do not choose one repository by itself.'}
						</p>
						<Input
							id="repository-directory"
							value={repositoryDirectory}
							onChange={(event) => setRepositoryDirectory(event.target.value)}
							placeholder={isSingleRepository ? '~/projects/devflow' : '~/projects'}
							className="font-mono"
							autoFocus
						/>
						<p className="text-xs text-muted-foreground">
							These locations are checked when the session starts.
						</p>
					</div>

					<div className="overflow-x-auto border">
						<table className="w-full table-fixed text-left text-xs">
							<thead className="border-b bg-muted/40 text-muted-foreground">
								<tr>
									<th className="w-1/3 px-3 py-2 font-medium">Repository</th>
									<th className="w-2/3 px-3 py-2 font-medium">Location on this host</th>
								</tr>
							</thead>
							<tbody>
								{placement.repositories.map((repository, index) => {
									return (
										<tr
											key={`${repository.localPath}:${index}`}
											className="border-b last:border-b-0"
										>
											<td className="px-3 py-2">
												<div className="font-medium">
													{repositoryName(repository.creatorPath)}
												</div>
												{!isSingleRepository && (
													<div className="truncate font-mono text-muted-foreground">
														{repository.relativePath}
													</div>
												)}
											</td>
											<td className="truncate px-3 py-2 font-mono" title={expectedPaths[index]}>
												{expectedPaths[index] || (
													<span className="italic">
														Choose a folder to preview this location
													</span>
												)}
											</td>
										</tr>
									)
								})}
							</tbody>
						</table>
					</div>

					<DialogFooter>
						<div className="flex gap-2">
							<Button variant="secondary" onClick={handleCancel}>
								Cancel
								<KeyboardShortcut size="xs" className="ml-1">
									Esc
								</KeyboardShortcut>
							</Button>
							<Button disabled={continueDisabled} onClick={handleContinue}>
								Use this location
								<KeyboardShortcut size="xs" className="ml-1">
									{typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
										? '⌘+Enter'
										: 'Ctrl+Enter'}
								</KeyboardShortcut>
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</HotkeyScopeBoundary>
	)
}
