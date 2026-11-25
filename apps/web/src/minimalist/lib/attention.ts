import type { TaskRow } from '@/minimalist/lib/data'

/**
 * Task overview only. Needs you comes from the shared notification inbox, not task status. A draft
 * isn't waiting on anyone, so it never asks for attention.
 */
export function attentionSections(rows: readonly TaskRow[], now = Date.now()) {
	const dayStart = new Date(now).setHours(0, 0, 0, 0)
	const started = rows.filter((row) => !row.task.is_draft)
	return {
		running: started.filter((row) => row.attention === 'running'),
		today: started.filter((row) => row.attention === 'idle' && row.lastActivity >= dayStart),
	}
}
