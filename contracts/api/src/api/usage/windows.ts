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

import { addDays, daysBetween, formatDayKey, mondayOf, parseDayKey } from '../metrics/range'

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

/** The period section's calendar periods, each to date. */
export const USAGE_PERIODS = ['week', 'month', 'year'] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

export const UsagePeriodSchema = z.enum(USAGE_PERIODS)

/** The period shown when the URL names none: "what did I spend this month?" */
export const DEFAULT_USAGE_PERIOD: UsagePeriod = 'month'

/** A period to date, the matching stretch of the period before it, and the chart's bucket starts. */
export interface PeriodWindows {
	/** The period so far: its first day through today. */
	current: DayWindow
	/**
	 * The comparison: the previous period over the same elapsed stretch, so a mid-period comparison is
	 * fair. Ends on the same day of its own period as today, clamped to that period's length.
	 */
	previous: DayWindow
	/**
	 * The first day of every chart bucket in the whole current period, ascending, future ones included
	 * so an early-period chart keeps its width: 7 days, every day of the month, or 12 month starts.
	 */
	slots: DayKey[]
}

/** A day key's year, month (1–12) and day of month. */
function partsOf(key: DayKey): { year: number; month: number; day: number } {
	return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8, 10)) }
}

/** The day key of `day` in the month `monthsBack` before `key`'s month, clamped to that month's last day. */
function sameDayMonthsBack(key: DayKey, monthsBack: number, day = partsOf(key).day): DayKey {
	const { year, month } = partsOf(key)
	// Date.UTC normalises an out-of-range month, so this walks back across year boundaries.
	const first = new Date(Date.UTC(year, month - 1 - monthsBack, 1))
	const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
	return formatDayKey(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, length)))
}

/**
 * The windows of a calendar period to date, as of `today`:
 *
 * | Period | `current`                          | `previous`                                   | `slots`          |
 * |--------|------------------------------------|----------------------------------------------|------------------|
 * | week   | Monday → today                     | last Monday → the same weekday               | 7 days           |
 * | month  | the 1st → today                    | last month's 1st → the same day, clamped     | every day        |
 * | year   | the 1st, 11 months back → today    | the 12 months before, to the same day        | 12 month starts  |
 *
 * So on Mar 31 the month compares with Feb 1–28 (Feb 1–29 in a leap year), and the year with the
 * twelve months before it, cut at the same day of the month.
 */
export function periodWindows(period: UsagePeriod, today: DayKey): PeriodWindows {
	if (period === 'week') {
		const monday = mondayOf(today)
		return {
			current: { from: monday, to: today },
			previous: { from: addDays(monday, -7), to: addDays(today, -7) },
			slots: Array.from({ length: 7 }, (_, index) => addDays(monday, index)),
		}
	}
	if (period === 'month') {
		const first = sameDayMonthsBack(today, 0, 1)
		const last = sameDayMonthsBack(today, 0, 31)
		const length = (daysBetween(first, last) ?? 0) + 1
		return {
			current: { from: first, to: today },
			previous: { from: sameDayMonthsBack(today, 1, 1), to: sameDayMonthsBack(today, 1) },
			slots: Array.from({ length }, (_, index) => addDays(first, index)),
		}
	}
	return {
		current: { from: sameDayMonthsBack(today, 11, 1), to: today },
		previous: { from: sameDayMonthsBack(today, 23, 1), to: sameDayMonthsBack(today, 12) },
		slots: Array.from({ length: 12 }, (_, index) => sameDayMonthsBack(today, 11 - index, 1)),
	}
}
