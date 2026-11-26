import z from 'zod/v4'

/**
 * Where a project's agents run. `default` follows the host's DEVFLOW_AGENT_SANDBOX; `vm` runs them in
 * a Lima VM (apps/agent-runner/src/devflow/vm-sandbox.ts), for projects whose agents need Docker.
 */
export const PROJECT_SANDBOXES = ['default', 'docker', 'vm', 'none'] as const
export const ProjectSandboxSchema = z.enum(PROJECT_SANDBOXES)
export type ProjectSandbox = z.infer<typeof ProjectSandboxSchema>

/** Which VM a `vm` project's task runs in: the host's shared VM, or one of the task's own. */
export const VM_SCOPES = ['shared', 'task'] as const
export const VmScopeSchema = z.enum(VM_SCOPES)
export type VmScope = z.infer<typeof VmScopeSchema>

/** A per-task CPU count or memory size in GiB, stored in a PostgreSQL integer. */
export const VmResourceQuantitySchema = z.int32().positive()

/** A task's sandbox, fixed at launch from its project. A null task sandbox follows the host default. */
export const TASK_SANDBOXES = ['docker', 'vm-shared', 'vm-task', 'none'] as const
export const TaskSandboxSchema = z.enum(TASK_SANDBOXES)
export type TaskSandbox = z.infer<typeof TaskSandboxSchema>

/** The sandbox a new task of a `project` gets; `vmScope` only matters for a `vm` project (default: own VM). */
export function taskSandboxFor(project: ProjectSandbox, vmScope: VmScope | undefined): TaskSandbox | null {
	switch (project) {
		case 'default':
			return null
		case 'docker':
			return 'docker'
		case 'none':
			return 'none'
		case 'vm':
			return vmScope === 'shared' ? 'vm-shared' : 'vm-task'
	}
}

/** A guest port the daemon forwards to `127.0.0.1:hostPort` on the VM's host. */
export const SandboxVmPortSchema = z.object({
	guestPort: z.number().int().min(1).max(65535),
	hostPort: z.number().int().min(1).max(65535),
})
export type SandboxVmPort = z.infer<typeof SandboxVmPortSchema>

export const SANDBOX_VM_STATUSES = ['starting', 'running', 'stopped', 'broken'] as const
export const SANDBOX_VMS_MAX = 256
export const SANDBOX_VM_PORTS_MAX = 64

/** One VM a daemon runs agents in, as reported with its heartbeat. */
export const SandboxVmSchema = z.object({
	/** The Lima instance name (devflow-shared, devflow-task-<id>). */
	name: z.string().regex(/^devflow-[a-z0-9-]{1,48}$/),
	kind: VmScopeSchema,
	/** The task a `task` VM belongs to; null for the shared VM. */
	taskId: z.uuid().nullable(),
	status: z.enum(SANDBOX_VM_STATUSES),
	ports: z.array(SandboxVmPortSchema).max(SANDBOX_VM_PORTS_MAX),
})
export type SandboxVm = z.infer<typeof SandboxVmSchema>

export const SandboxVmsSchema = z.array(SandboxVmSchema).max(SANDBOX_VMS_MAX)
export type SandboxVms = z.infer<typeof SandboxVmsSchema>
