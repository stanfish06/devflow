import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const workflowSkillContract = contractBuilder.input(z.object({ sessionId: z.uuid() })).output(
	z.object({
		skill: z.string().nullable(),
		conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
	}),
)
