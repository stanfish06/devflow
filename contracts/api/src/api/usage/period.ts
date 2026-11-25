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

/** One bar of the cost-by-model chart: a day, or a month for the year period. */
export const PeriodBucketSchema = z.object({
	/** The bucket's first day: one of `periodWindows(period, today).slots`. */
	start: DayKeySchema,
	/** Dollars per model ID spent in the bucket; models with no ledger rows in it are absent. */
	costByModel: z.record(z.string(), z.number().nonnegative()),
})

/** A model's spend over the current period. */
export const PeriodModelCostSchema = z.object({
	model: z.string(),
	costUsd: z.number().nonnegative(),
})

/** One of the period's most expensive tasks, counting only the sessions the caller started. */
export const PeriodTopTaskSchema = z.object({
	taskId: z.string(),
	name: z.string(),
	archived: z.boolean(),
	/** Every token kind, cache reads included. */
	tokens: z.number().int().nonnegative(),
	costUsd: z.number().nonnegative(),
})

/** How many tasks the top-tasks table lists. */
export const USAGE_TOP_TASKS = 5

export const UsagePeriodOutputSchema = z.object({
	/** The period to date. */
	current: PeriodTotalsSchema,
	/** The previous period over the same elapsed stretch, for "vs last month". */
	previous: PeriodTotalsSchema,
	/**
	 * Dense over every slot of the current period, ascending, future slots included (empty), so the chart
	 * keeps its width early in a period.
	 */
	buckets: z.array(PeriodBucketSchema),
	/** Every model with ledger rows in the current period, most expensive first. */
	byModel: z.array(PeriodModelCostSchema),
	/** The current period's {@link USAGE_TOP_TASKS} most expensive tasks, most expensive first. */
	topTasks: z.array(PeriodTopTaskSchema),
})

export type UsagePeriodInput = z.infer<typeof UsagePeriodInputSchema>
export type PeriodTotals = z.infer<typeof PeriodTotalsSchema>
export type PeriodBucket = z.infer<typeof PeriodBucketSchema>
export type PeriodModelCost = z.infer<typeof PeriodModelCostSchema>
export type PeriodTopTask = z.infer<typeof PeriodTopTaskSchema>
export type UsagePeriodOutput = z.infer<typeof UsagePeriodOutputSchema>

export const usagePeriodContract = contractBuilder.input(UsagePeriodInputSchema).output(UsagePeriodOutputSchema)
