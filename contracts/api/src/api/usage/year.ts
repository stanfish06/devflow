import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { timezoneOffsetSchema } from '../metrics/range'
import { DayKeySchema } from './windows'

/**
 * The year grid's input. The client sends its own local `today` and offset;
 * the caller's user and organization always come from authentication.
 */
export const UsageYearInputSchema = z.object({
	today: DayKeySchema,
	timezoneOffset: timezoneOffsetSchema,
})

/** One local day of the caller's own activity: what they created and sent. */
export const DayUsageSchema = z.object({
	date: z.string(),
	/** Tasks the caller created. */
	tasks: z.number().int().nonnegative(),
	/** Sessions the caller started. */
	sessions: z.number().int().nonnegative(),
	/** Prompts and follow-ups the caller sent. */
	messages: z.number().int().nonnegative(),
})

export const UsageYearOutputSchema = z.object({
	/** Dense: one entry per local day of `yearWindow(today)`, ascending. */
	days: z.array(DayUsageSchema),
})

export type UsageYearInput = z.infer<typeof UsageYearInputSchema>
export type DayUsage = z.infer<typeof DayUsageSchema>
export type UsageYearOutput = z.infer<typeof UsageYearOutputSchema>

export const usageYearContract = contractBuilder.input(UsageYearInputSchema).output(UsageYearOutputSchema)
