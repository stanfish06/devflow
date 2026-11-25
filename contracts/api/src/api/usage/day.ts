import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'
import { timezoneOffsetSchema } from '../metrics/range'
import { DayKeySchema } from './windows'

/**
 * The day list's input: one local day of the client's calendar. The caller's
 * user and organization always come from authentication.
 */
export const UsageDayInputSchema = z.object({
	date: DayKeySchema,
	timezoneOffset: timezoneOffsetSchema,
})

/**
 * One thing the caller worked on that day: a task, or a session with no task.
 * Everything the caller did in a task's sessions rolls up into the task's row.
 */
export const UsageDayRowSchema = z.object({
	kind: z.enum(['task', 'session']),
	/** The task's id for a task row, the session's id for a session row. */
	id: z.string(),
	name: z.string(),
	archived: z.boolean(),
	/** The caller created this task (or started this session) on the day. */
	created: z.boolean(),
	/** Sessions the caller started that day: in the task, or this session itself. */
	sessions: z.number().int().nonnegative(),
	/** Prompts and follow-ups the caller sent that day. */
	messages: z.number().int().nonnegative(),
	/**
	 * Every token kind, cache reads included, used that day by sessions the
	 * caller started. `null` when there are no usage-ledger rows for the row
	 * that day ("No token data recorded"), never zero.
	 */
	tokens: z.number().int().nonnegative().nullable(),
	/** Dollars spent that day; `null` under the same rule as `tokens`. */
	costUsd: z.number().nonnegative().nullable(),
})

export const UsageDayOutputSchema = z.object({
	/** Ranked by activity, highest first; then by cost. */
	rows: z.array(UsageDayRowSchema),
})

export type UsageDayInput = z.infer<typeof UsageDayInputSchema>
export type UsageDayRow = z.infer<typeof UsageDayRowSchema>
export type UsageDayOutput = z.infer<typeof UsageDayOutputSchema>

/**
 * A row's activity count, on the year grid's terms: creating the task, each
 * session started and each prompt sent count one apiece. A session row's own
 * start is already its `sessions`, so it isn't counted twice. The day's rows
 * add up to the day's cell.
 */
export function usageDayRowActivity(row: Pick<UsageDayRow, 'kind' | 'created' | 'sessions' | 'messages'>): number {
	return (row.kind === 'task' && row.created ? 1 : 0) + row.sessions + row.messages
}

export const usageDayContract = contractBuilder.input(UsageDayInputSchema).output(UsageDayOutputSchema)
