import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { timezoneOffsetSchema } from '../metrics/range'
import { DayKeySchema, UsagePeriodSchema } from './windows'
import { TokenBreakdownSchema } from './year'

/**
 * The period section's input: which calendar period, as of the client's own local `today` and offset.
 * The caller's user and organization always come from authentication.
 */
export const UsagePeriodInputSchema = z.object({
	period: UsagePeriodSchema,
	today: DayKeySchema,
	timezoneOffset: timezoneOffsetSchema,
})

/** The caller's totals over one window of `periodWindows`, counted exactly as the year grid counts them. */
export const PeriodTotalsSchema = z.object({
	/** Tasks the caller created. */
	tasks: z.number().int().nonnegative(),
	/** Sessions the caller started. */
	sessions: z.number().int().nonnegative(),
	/** Prompts and follow-ups the caller sent. */
	messages: z.number().int().nonnegative(),
	/**
	 * Tokens used by sessions the caller started. `null` when the window has no usage-ledger rows at all,
	 * which the page shows as "No token data recorded", never as zero.
	 */
	tokens: TokenBreakdownSchema.nullable(),
	/** Dollars spent by sessions the caller started; `null` under the same rule as `tokens`. */
	costUsd: z.number().nonnegative().nullable(),
	/** Days in the window with at least one activity. */
	activeDays: z.number().int().nonnegative(),
	/** Days the window covers, through today for the current one: the "/ 24" of "19 / 24". */
	elapsedDays: z.number().int().nonnegative(),
	/** The weekday with the most activities, 0 = Monday … 6 = Sunday; `null` with no activity. */
	topWeekday: z.number().int().min(0).max(6).nullable(),
})

export const UsagePeriodOutputSchema = z.object({
	/** The period to date. */
	current: PeriodTotalsSchema,
	/** The previous period over the same elapsed stretch, for "vs last month". */
	previous: PeriodTotalsSchema,
})

export type UsagePeriodInput = z.infer<typeof UsagePeriodInputSchema>
export type PeriodTotals = z.infer<typeof PeriodTotalsSchema>
export type UsagePeriodOutput = z.infer<typeof UsagePeriodOutputSchema>

export const usagePeriodContract = contractBuilder.input(UsagePeriodInputSchema).output(UsagePeriodOutputSchema)
