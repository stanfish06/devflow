/**
 * Pure shaping for the usage procedures: query rows in, response shapes out.
 * No database here, so every rule is unit-testable on its own.
 */

import { enumerateBuckets } from '@devflow/api-contract/api/metrics/range'
import type { DayWindow } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage, TokenBreakdown } from '@devflow/api-contract/api/usage/year'

/** A number column as the driver may hand it back: an int, numeric text, or NULL. */
type Numeric = number | string | null

/**
 * One day of the year query: activity counts and ledger sums, joined on the day.
 * Days with neither are absent. On a day with activity but no ledger rows the
 * usage columns are NULL and `ledger_rows` is NULL or 0.
 */
export type YearDayRow = {
	day: string
	tasks: Numeric
	sessions: Numeric
	messages: Numeric
	ledger_rows?: Numeric
	cache_read?: Numeric
	cache_write?: Numeric
	input?: Numeric
	output?: Numeric
	cost_usd?: Numeric
}

/** A number column as a number; NULL and garbage read as 0. */
function num(value: Numeric | undefined): number {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) ? parsed : 0
}

/**
 * A row's tokens and cost, or `null` for both when it has no ledger rows.
 * "No rows" and "rows that sum to zero" are different facts: the first is
 * "No token data recorded" (before recording began, or Codex-only work), the
 * second a real $0.00. With rows present, a missing cost (the SDK didn't
 * report one) sums as zero rather than hiding the tokens.
 */
export function ledgerUsage(row: Omit<YearDayRow, 'day' | 'tasks' | 'sessions' | 'messages'> | undefined): {
	tokens: TokenBreakdown | null
	costUsd: number | null
} {
	if (!row || num(row.ledger_rows) === 0) return { tokens: null, costUsd: null }
	return {
		tokens: {
			cacheRead: num(row.cache_read),
			cacheWrite: num(row.cache_write),
			input: num(row.input),
			output: num(row.output),
		},
		costUsd: num(row.cost_usd),
	}
}

/**
 * One entry per local day of the window, ascending, with zero activity and null
 * usage where the query returned nothing. Rows outside the window are dropped
 * rather than appended, so the response always has exactly the grid's days.
 */
export function zeroFillDays(rows: readonly YearDayRow[], window: DayWindow): DayUsage[] {
	const byDay = new Map(rows.map((row) => [row.day, row]))
	return enumerateBuckets(window.from, window.to, 'day').map((date) => {
		const row = byDay.get(date)
		return {
			date,
			tasks: num(row?.tasks),
			sessions: num(row?.sessions),
			messages: num(row?.messages),
			...ledgerUsage(row),
		}
	})
}
