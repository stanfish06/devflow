import type { Task } from '@devflow/db/tables/tasks'

import { type DraftTarget, parseDraftLaunch } from '@/minimalist/lib/launch-form'

type DraftHost = { host: { host_id: string }; name: string; online: boolean }

/**
 * Why a draft can't start where it was saved for; null when it can. A draft never falls back to
 * another host or project: running code on a machine you didn't pick is worse than asking.
 * `projects` is undefined while they load.
 */
export function draftStartBlocker(
	draft: { hostId: string | null; target: DraftTarget | null },
	hosts: readonly DraftHost[],
	projects: readonly { id: string }[] | undefined,
): string | null {
	if (!draft.hostId) return hosts.length === 0 ? 'Start a daemon to launch sessions' : 'Choose a host for this draft'
	const host = hosts.find((entry) => entry.host.host_id === draft.hostId)
	if (!host) return "This draft's host is no longer registered. Choose another host."
	if (!host.online) return `${host.name} is offline`
	const target = draft.target
	if (!target) return 'Choose a project or directory'
	if (target.kind === 'project') {
		if (!projects) return 'Loading…'
		if (!projects.some((project) => project.id === target.projectId))
			return "This draft's project is no longer available. Choose another project."
	}
	return null
}

/** Why a saved draft can't start as it was saved, read from its snapshot; null when it can. */
export function startBlocker(
	row: { task: Pick<Task, 'draft_launch'> },
	hosts: readonly DraftHost[],
	projects: readonly { id: string }[] | undefined,
): string | null {
	const parsed = parseDraftLaunch(row.task.draft_launch)
	if (!parsed.ok) return parsed.error
	return draftStartBlocker({ hostId: parsed.snapshot.hostId, target: parsed.snapshot.target }, hosts, projects)
}
