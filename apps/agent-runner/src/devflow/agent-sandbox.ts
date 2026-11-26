/**
 * Which sandbox a session's agent runs in. A task's sandbox is fixed at launch from its project
 * (tasks.sandbox); a task without one, or a session without a task, follows the host's
 * DEVFLOW_AGENT_SANDBOX (`docker`, `vm` for the shared VM, anything else for none).
 */
import type { TaskSandbox } from '@devflow/schemas/zod/host/agent-sandbox'

export type SessionSandbox = TaskSandbox

export function hostDefaultSandbox(value: string | undefined = process.env.DEVFLOW_AGENT_SANDBOX): SessionSandbox {
	if (value === 'docker') return 'docker'
	if (value === 'vm') return 'vm-shared'
	return 'none'
}

/** A task VM needs a task to belong to; without one the session uses the shared VM. */
export function sessionSandbox(
	task: { readonly id: string; readonly sandbox?: TaskSandbox | null } | null | undefined,
	hostDefault: string | undefined = process.env.DEVFLOW_AGENT_SANDBOX,
): SessionSandbox {
	const chosen = task?.sandbox ?? hostDefaultSandbox(hostDefault)
	return chosen === 'vm-task' && !task ? 'vm-shared' : chosen
}

export const isVmSandbox = (sandbox: SessionSandbox): sandbox is 'vm-shared' | 'vm-task' =>
	sandbox === 'vm-shared' || sandbox === 'vm-task'

/** GitHub credential files for a sandboxed agent must not include the host user's own git config. */
export const githubCredentialScope = (sandbox: SessionSandbox): 'sandbox' | 'host' =>
	sandbox === 'none' ? 'host' : 'sandbox'

/**
 * The task's own row, for its sandbox. A session can start before its task row reaches this host's
 * collection; running it under the host default then could put a VM task on the host, so this waits
 * for the row and fails when it never arrives.
 */
export async function waitForTaskSandbox(
	get: (taskId: string) =>
		| {
				readonly sandbox?: TaskSandbox | null
				readonly vm_cpus?: number | null
				readonly vm_memory_gib?: number | null
		  }
		| undefined,
	taskId: string,
	timeoutMs = 15_000,
) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const task = get(taskId)
		if (task) {
			return {
				id: taskId,
				sandbox: task.sandbox ?? null,
				vmResources:
					task.sandbox === 'vm-task'
						? { cpus: task.vm_cpus ?? undefined, memoryGiB: task.vm_memory_gib ?? undefined }
						: undefined,
			}
		}
		if (Date.now() >= deadline)
			throw new Error(`Task ${taskId} has not synced to this host, so its sandbox is unknown; retry the session`)
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

/** How often a session waiting for its VM reports activity; the sweeper marks a launch lost after 2 minutes without. */
export const VM_LAUNCH_ACTIVITY_MS = 30_000

/**
 * Await `work` (a VM starting, which can take minutes the first time) while calling `bump` on an
 * interval, so the launching session keeps showing activity instead of being swept as lost.
 */
export async function whileLaunching<A>(
	work: Promise<A>,
	bump: () => Promise<unknown>,
	everyMs = VM_LAUNCH_ACTIVITY_MS,
): Promise<A> {
	const timer = setInterval(() => {
		bump().catch(() => undefined)
	}, everyMs)
	try {
		return await work
	} finally {
		clearInterval(timer)
	}
}
