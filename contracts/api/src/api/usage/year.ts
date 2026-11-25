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

/**
 * The four kinds of token Claude reports, as the usage ledger stores them:
 * `input` excludes the cache, which is counted separately. Their sum is the
 * "total" a session's cost badge shows.
 */
export const TokenBreakdownSchema = z.object({
	cacheRead: z.number().int().nonnegative(),
	cacheWrite: z.number().int().nonnegative(),
	input: z.number().int().nonnegative(),
	output: z.number().int().nonnegative(),
})

/** One local day of the caller's own activity and usage. */
export const DayUsageSchema = z.object({
	date: z.string(),
	/** Tasks the caller created. */
	tasks: z.number().int().nonnegative(),
	/** Sessions the caller started. */
	sessions: z.number().int().nonnegative(),
	/** Prompts and follow-ups the caller sent. */
	messages: z.number().int().nonnegative(),
	/**
	 * Tokens used by sessions the caller started. `null` when the day has no
	 * usage-ledger rows at all (before recording began, or Codex-only work),
	 * which the page shows as "No token data recorded", never as zero.
	 */
	tokens: TokenBreakdownSchema.nullable(),
	/** Dollars spent by sessions the caller started; `null` under the same rule as `tokens`. */
	costUsd: z.number().nonnegative().nullable(),
})

export const UsageYearOutputSchema = z.object({
	/** Dense: one entry per local day of `yearWindow(today)`, ascending. */
	days: z.array(DayUsageSchema),
})

export type UsageYearInput = z.infer<typeof UsageYearInputSchema>
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>
export type DayUsage = z.infer<typeof DayUsageSchema>
export type UsageYearOutput = z.infer<typeof UsageYearOutputSchema>

export const usageYearContract = contractBuilder.input(UsageYearInputSchema).output(UsageYearOutputSchema)
