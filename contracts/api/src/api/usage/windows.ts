/**
 * The calendar rules of the personal usage page, shared by the API (to bound
 * its queries) and the web app (to lay out the grid), so the two sides can't
 * disagree about which days a window covers.
 *
 * Every date is a day key, 'YYYY-MM-DD' in the CLIENT's local calendar, and
 * all arithmetic is naive-UTC epoch math on the key (see `metrics/range.ts`).
 * The client's real offset enters only where the API turns a key into an
 * instant.
 */

import z from 'zod/v4'

import { addDays, mondayOf, parseDayKey } from '../metrics/range'

/** A 'YYYY-MM-DD' local calendar day. */
export type DayKey = string

/** An inclusive range of local days. */
export interface DayWindow {
	from: DayKey
	to: DayKey
}

/** A real calendar day as 'YYYY-MM-DD'; '2026-02-30' and '2026-2-3' are refused. */
export const DayKeySchema = z
	.string()
	.refine((value) => parseDayKey(value) !== null, { message: 'expected a YYYY-MM-DD calendar date' })

/** Whole weeks before the current one that the year grid shows. */
export const YEAR_GRID_PAST_WEEKS = 52

/**
 * The year grid's window: the Monday 52 weeks before this week's Monday,
 * through today. That is 52 whole Monday-to-Sunday columns plus the current,
 * partial one, so the grid always has 53 columns whatever the weekday.
 */
export function yearWindow(today: DayKey): DayWindow {
	return { from: addDays(mondayOf(today), -YEAR_GRID_PAST_WEEKS * 7), to: today }
}
