import { permissionsModeSchema } from '@devflow/db/tables/sessions'
import z from 'zod/v4'

import { LaunchTaskDraftAttachmentInputSchema } from './launch-draft'

/**
 * What a board draft launches with: the composer as it was saved. It holds what the user picked
 * (the task size, not the workflow it resolves to); Start rebuilds the launch from it. Ticket
 * fields live on the task row. Validated on write only: `tasks.draft_launch` syncs as unknown,
 * and readers parse it, so a newer version never breaks an older reader.
 */
export const DraftLaunchSchema = z.object({
	version: z.literal(1),
	prompt: z.string(),
	attachments: z.array(LaunchTaskDraftAttachmentInputSchema).max(50),
	target: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('project'), projectId: z.uuid() }),
		z.object({ kind: z.literal('directory'), path: z.string().min(1) }),
	]),
	hostId: z.string(),
	settings: z.object({
		agent: z.enum(['claude', 'codelayer']),
		model: z.string(),
		effort: z.string().nullable(),
		fastMode: z.boolean(),
		permissionsMode: permissionsModeSchema,
	}),
	taskSize: z.enum(['small', 'medium', 'large', 'unknown']),
	smallAutoAdvance: z.boolean(),
})

export type DraftLaunch = z.infer<typeof DraftLaunchSchema>
