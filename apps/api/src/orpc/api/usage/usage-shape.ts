/**
 * Pure shaping for the usage procedures: query rows in, response shapes out.
 * No database here, so every rule is unit-testable on its own.
 */

import { enumerateBuckets } from '@devflow/api-contract/api/metrics/range'
import { type UsageDayRow, usageDayRowActivity } from '@devflow/api-contract/api/usage/day'
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

/**
 * One thing the caller worked on during the day query's day: a task, or a session with no task, with
 * its activity and ledger sums already aggregated. Activity columns are NULL for an item that only
 * spent tokens that day; the usage columns are NULL, and `ledger_rows` NULL or 0, for one that
 * recorded none.
 */
export type DayItemRow = {
	kind: string
	id: string
	name: string | null
	archived: boolean | null
	created: boolean | null
	sessions: Numeric
	messages: Numeric
	ledger_rows: Numeric
	tokens: Numeric
	cost_usd: Numeric
}

/**
 * The day list: one row per task or task-less session, ranked by the day's activity, highest first,
 * so the main work sits at the top. Ties, including rows that only spent tokens that day, go by cost,
 * then tokens, then name. Tokens and cost follow the same null rule as the year grid: no ledger rows
 * is "No token data recorded", not zero.
 */
export function buildDayRows(rows: readonly DayItemRow[]): UsageDayRow[] {
	const shaped = rows.map((row): UsageDayRow => {
		const kind = row.kind === 'task' ? 'task' : 'session'
		const hasLedger = num(row.ledger_rows) > 0
		return {
			kind,
			id: row.id,
			name: row.name?.trim() || (kind === 'task' ? 'Untitled task' : 'Untitled session'),
			archived: row.archived === true,
			created: row.created === true,
			sessions: num(row.sessions),
			messages: num(row.messages),
			tokens: hasLedger ? num(row.tokens) : null,
			costUsd: hasLedger ? num(row.cost_usd) : null,
		}
	})
	return shaped.sort(
		(a, b) =>
			usageDayRowActivity(b) - usageDayRowActivity(a) ||
			(b.costUsd ?? -1) - (a.costUsd ?? -1) ||
			(b.tokens ?? -1) - (a.tokens ?? -1) ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id),
	)
}
