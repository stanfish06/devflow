import type { ProjectGroup, TaskRow } from '@/minimalist/lib/data'
import type { WorkingHost } from '@/minimalist/lib/working-host-store'

/**
 * The sidebar's groups on the working host. A project shows where you have a checkout of it, or
 * everywhere when it clones on demand; a folder group shows where its sessions ran, or everywhere
 * when they never ran. "All hosts" shows every group.
 */
export function maskGroups(groups: ProjectGroup[], working: WorkingHost): ProjectGroup[] {
	if (working === 'all') return groups
	return groups.filter((group) => group.hostIds === null || group.hostIds.includes(working))
}

/**
 * The host to tag a task row with: where its latest session ran, when that isn't the working
 * host. Null on "All hosts", for a task that ran on the working host, and for one that never ran.
 */
export function elsewhereHost(row: Pick<TaskRow, 'latestHostId'>, working: WorkingHost): string | null {
	if (working === 'all' || row.latestHostId === null || row.latestHostId === working) return null
	return row.latestHostId
}
