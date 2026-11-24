/**
 * Pure shaping for the usage procedures: query rows in, response shapes out.
 * No database here, so every rule is unit-testable on its own.
 */

import { enumerateBuckets } from '@devflow/api-contract/api/metrics/range'
import type { DayWindow } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage } from '@devflow/api-contract/api/usage/year'

/** One day's activity counts as the year query returns them; days without activity are absent. */
export type ActivityDayRow = {
	day: string
	tasks: number | string
	sessions: number | string
	messages: number | string
}

/** A count column as a number, whether the driver hands back an int or numeric text. */
function count(value: number | string | null | undefined): number {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) ? parsed : 0
}

/**
 * One entry per local day of the window, ascending, with zeros where the query
 * returned nothing. Rows outside the window are dropped rather than appended,
 * so the response always has exactly the grid's days.
 */
export function zeroFillDays(rows: readonly ActivityDayRow[], window: DayWindow): DayUsage[] {
	const byDay = new Map(rows.map((row) => [row.day, row]))
	return enumerateBuckets(window.from, window.to, 'day').map((date) => {
		const row = byDay.get(date)
		return {
			date,
			tasks: count(row?.tasks),
			sessions: count(row?.sessions),
			messages: count(row?.messages),
		}
	})
}
