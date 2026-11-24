import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

export const RelaunchSessionInputSchema = z.object({
	sessionId: z.uuid(),
})

export const RelaunchSessionOutputSchema = z.object({
	transactionId: z.string(),
	success: z.boolean(),
})

export const relaunchSessionContract = contractBuilder
	.input(RelaunchSessionInputSchema)
	.output(RelaunchSessionOutputSchema)
