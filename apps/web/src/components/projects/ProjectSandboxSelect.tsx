import { type ProjectSandbox, ProjectSandboxSchema } from '@devflow/schemas/zod/host/agent-sandbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@devflow/ui/components/select'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { useApi } from '@/orpc/client'

const SANDBOX_LABELS: Record<ProjectSandbox, string> = {
	default: 'Host default',
	// Codex keeps its own sandbox on the host; only Claude Code runs in the container.
	docker: 'Docker (Claude Code)',
	vm: 'VM (Docker inside)',
	none: 'None (on the host)',
}

/**
 * Where the project's agents run; new tasks copy it at launch. `vm` is for projects whose agents
 * need Docker. Only the project's owner changes it.
 */
export function ProjectSandboxSelect({
	project,
	canEdit,
	onSaved,
}: {
	readonly project: { readonly id: string; readonly name: string; readonly sandbox: ProjectSandbox }
	readonly canEdit: boolean
	readonly onSaved: () => Promise<void>
}) {
	const { client } = useApi()
	const save = useMutation({
		mutationFn: (sandbox: ProjectSandbox) =>
			client.projects.v2.update({ projectId: project.id, sandbox }, { context: { silent: true } }),
		onSuccess: onSaved,
		onError: () => toast.error('Could not change the sandbox. Try again.'),
	})
	const id = `project-sandbox-${project.id}`
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 py-2">
			<label htmlFor={id} className="text-sm font-medium">
				Agent sandbox
			</label>
			<Select
				value={project.sandbox}
				disabled={!canEdit || save.isPending}
				onValueChange={(value) => {
					const parsed = ProjectSandboxSchema.safeParse(value)
					if (parsed.success) save.mutate(parsed.data)
				}}
			>
				<SelectTrigger
					id={id}
					aria-label={`Agent sandbox for ${project.name}`}
					className="w-full shrink-0 sm:w-[240px]"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{ProjectSandboxSchema.options.map((sandbox) => (
						<SelectItem key={sandbox} value={sandbox}>
							{SANDBOX_LABELS[sandbox]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}
