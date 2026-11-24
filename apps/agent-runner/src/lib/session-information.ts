import type { Session } from '@devflow/db/tables/sessions'
import type { Task } from '@devflow/db/tables/tasks'

type SessionInformationSession = Pick<
	Session,
	'id' | 'host_id' | 'coding_agent' | 'provider' | 'model' | 'effort' | 'permissions_mode'
>
type SessionInformationTask = Pick<Task, 'id' | 'slug' | 'workspace_id'>

/**
 * Render the `<app_session>` system-prompt block with the IDs and agent settings a skill needs
 * to act on this session (for example, `/hl:teleport` launching a sibling session on another host).
 * Identical text for every coding agent.
 */
export function renderSessionInformation(
	session: SessionInformationSession,
	task: SessionInformationTask | null | undefined,
): string {
	return [
		'<app_session>',
		`Session ID: ${session.id}`,
		`Task ID: ${task?.id ?? 'none'}`,
		`Task slug: ${task?.slug ?? 'none'}`,
		`Workspace ID: ${task?.workspace_id ?? 'none'}`,
		`Host ID: ${session.host_id}`,
		`Coding agent: ${session.coding_agent}`,
		`Provider: ${session.provider ?? 'none'}`,
		`Model: ${session.model ?? 'none'}`,
		`Effort: ${session.effort ?? 'none'}`,
		`Permissions mode: ${session.permissions_mode}`,
		'</app_session>',
	].join('\n')
}
