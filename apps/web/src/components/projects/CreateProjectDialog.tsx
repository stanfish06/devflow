import type { ProjectV2 } from '@devflow/api-contract/api/projects-v2/schemas'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@devflow/ui/components/dialog'
import { useState } from 'react'

import { ProjectCreatorWired } from '@/components/projects/ProjectCreatorWired'

/** Creates a project in a dialog, with the same repository recipe form as the settings page. */
export function CreateProjectDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
	readonly onCreated: (project: ProjectV2) => void
}) {
	const [submitting, setSubmitting] = useState(false)
	const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && submitting) return
				onOpenChange(nextOpen)
			}}
		>
			<DialogContent
				ref={setPortalContainer}
				className="flex h-[85vh] max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl"
			>
				<div data-testid="create-project-scroll-area" className="min-h-0 flex-1 space-y-4 overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Create new project</DialogTitle>
						<DialogDescription>
							A project is a reusable recipe for repositories and their setup instructions. It creates a
							workspace for each task that uses it.
						</DialogDescription>
					</DialogHeader>
					<ProjectCreatorWired
						repositoryPickerPortalContainer={portalContainer}
						onCancel={() => {
							if (!submitting) onOpenChange(false)
						}}
						onSubmittingChange={setSubmitting}
						onCreated={(project) => {
							onCreated(project)
							onOpenChange(false)
						}}
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}
