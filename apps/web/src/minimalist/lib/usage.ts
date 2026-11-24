// Pure logic behind the usage page: the year grid's calendar layout, streaks, shading and the words
// around them. The server computes every number; this only arranges and describes them.
import { dayOfWeek, parseDayKey } from '@devflow/api-contract/api/metrics/range'
import type { UsageDayRow } from '@devflow/api-contract/api/usage/day'
import type { PeriodTotals } from '@devflow/api-contract/api/usage/period'
import type { UsagePeriod } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage, TokenBreakdown } from '@devflow/api-contract/api/usage/year'

/** What the grid's cells measure: things you did, tokens your sessions used, or what they cost. */
export type UsageLens = 'activity' | 'tokens' | 'cost'

export const USAGE_LENSES: ReadonlyArray<{ value: UsageLens; label: string }> = [
	{ value: 'activity', label: 'Activity' },
	{ value: 'tokens', label: 'Tokens' },
	{ value: 'cost', label: 'Cost' },
]

export type IntensityLevel = 0 | 1 | 2 | 3 | 4
export type Thresholds = [number, number, number]

/** The local calendar day of `date` as 'YYYY-MM-DD'. */
export function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

/** Every token kind together, cache reads included: the same total a session's cost badge shows. */
export function totalTokens(tokens: TokenBreakdown): number {
	return tokens.cacheRead + tokens.cacheWrite + tokens.input + tokens.output
}

/** A day's value under a lens. A day with no token data counts as zero for shading and totals. */
export function lensValue(day: DayUsage, lens: UsageLens): number {
	if (lens === 'tokens') return day.tokens ? totalTokens(day.tokens) : 0
	if (lens === 'cost') return day.costUsd ?? 0
	return day.tasks + day.sessions + day.messages
}

// ── Grid layout ──────────────────────────────────────────────────────────────

export type GridCell = { day: DayUsage; weekday: number }
export type MonthLabel = { column: number; label: string }
export type GridLayout = { weeks: GridCell[][]; months: MonthLabel[] }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** The month of a day key, 0 = January. */
function monthOf(key: string): number {
	return Number(key.slice(5, 7)) - 1
}

/**
 * Monday-to-Sunday columns of days, oldest first; the last column stops at today. A month is labelled
 * over the first column whose Monday falls in it, and only when that Monday is in the month's first
 * week, so the first, partial month never crowds the next label.
 */
export function gridLayout(days: readonly DayUsage[]): GridLayout {
	const weeks: GridCell[][] = []
	for (const day of days) {
		const weekday = dayOfWeek(day.date) ?? 0
		if (weekday === 0 || weeks.length === 0) weeks.push([])
		weeks.at(-1)?.push({ day, weekday })
	}
	const months: MonthLabel[] = []
	let previousMonth: number | null = null
	weeks.forEach((week, column) => {
		const first = week[0]?.day.date
		if (!first) return
		const month = monthOf(first)
		if (month !== previousMonth && Number(first.slice(8, 10)) <= 7)
			months.push({ column, label: MONTHS[month] ?? '' })
		previousMonth = month
	})
	return { weeks, months }
}

// ── Streaks ──────────────────────────────────────────────────────────────────

/**
 * The current streak counts consecutive active days ending today, or ending yesterday when today has
 * nothing yet, so it doesn't drop to zero first thing in the morning. `days` is dense and ends today.
 */
export function streaks(days: readonly DayUsage[]): { current: number; longest: number } {
	let longest = 0
	let run = 0
	for (const day of days) {
		run = lensValue(day, 'activity') > 0 ? run + 1 : 0
		longest = Math.max(longest, run)
	}
	let current = 0
	let index = days.length - 1
	const today = days[index]
	if (today && lensValue(today, 'activity') === 0) index -= 1
	for (; index >= 0; index--) {
		const day = days[index]
		if (!day || lensValue(day, 'activity') === 0) break
		current += 1
	}
	return { current, longest }
}

// ── Shading ──────────────────────────────────────────────────────────────────

function median(sorted: readonly number[]): number {
	if (sorted.length === 0) return 0
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Cut points for shades 1–4: the quartiles of the year's non-zero values (Tukey's hinges: the medians
 * of the lower half, the whole, and the upper half). Relative to your own year, so a light and a heavy
 * user both get a readable spread, and one outlier can't wash every other day out to shade 1.
 * [1, 2, 2, 3, 5, 8, 14, 40] → [2, 4, 11].
 */
export function intensityThresholds(values: readonly number[]): Thresholds {
	const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
	if (sorted.length === 0) return [0, 0, 0]
	const half = Math.floor(sorted.length / 2)
	const lower = half > 0 ? sorted.slice(0, half) : sorted
	const upper = half > 0 ? sorted.slice(sorted.length - half) : sorted
	return [median(lower), median(sorted), median(upper)]
}

export function intensityLevel(value: number, thresholds: Thresholds): IntensityLevel {
	if (value <= 0) return 0
	if (value <= thresholds[0]) return 1
	if (value <= thresholds[1]) return 2
	if (value <= thresholds[2]) return 3
	return 4
}

// ── Words ────────────────────────────────────────────────────────────────────

const count = new Intl.NumberFormat('en-US')

function plural(value: number, one: string, many = `${one}s`): string {
	return `${count.format(value)} ${value === 1 ? one : many}`
}

/** One decimal, dropping a trailing '.0': 2.1, 48.2, 1. */
function oneDecimal(value: number): string {
	return String(Math.round(value * 10) / 10)
}

/**
 * Token counts, exact while they're small enough to read and short after: '1,200', '12k', '140k',
 * '2.1M', '48.2M', '1.3B'. Rounding never reads as the next unit up ('1000k').
 */
export function formatTokenCount(value: number): string {
	if (value < 10_000) return count.format(value)
	if (value < 999_500) return `${Math.round(value / 1000)}k`
	if (value < 999_950_000) return `${oneDecimal(value / 1_000_000)}M`
	return `${oneDecimal(value / 1_000_000_000)}B`
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** Dollars to the cent: '$0.12', '$1,612.40'. A real but sub-cent spend reads '<$0.01', not '$0.00'. */
export function formatCost(usd: number): string {
	if (usd > 0 && usd < 0.005) return '<$0.01'
	return dollars.format(usd)
}

/** What a cell's tooltip says for a day with activity but no usage-ledger rows. */
export const NO_TOKEN_DATA = 'No token data recorded'

/** The four token kinds: '1.9M cache read · 140k cache write · 12k input · 48k output'. */
export function tokenBreakdown(tokens: TokenBreakdown): string {
	return [
		`${formatTokenCount(tokens.cacheRead)} cache read`,
		`${formatTokenCount(tokens.cacheWrite)} cache write`,
		`${formatTokenCount(tokens.input)} input`,
		`${formatTokenCount(tokens.output)} output`,
	].join(' · ')
}

/** '2.1M tokens: 1.9M cache read · 140k cache write · 12k input · 48k output'. */
export function tokenSummary(tokens: TokenBreakdown): string {
	const total = totalTokens(tokens)
	return `${formatTokenCount(total)} ${total === 1 ? 'token' : 'tokens'}: ${tokenBreakdown(tokens)}`
}

/** 'Wed, Nov 18, 2026' for a day key, whatever the browser's time zone. */
export function formatDayLong(key: string): string {
	return new Date(parseDayKey(key) ?? 0).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

function formatDayShort(key: string): string {
	return new Date(parseDayKey(key) ?? 0).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	})
}

/**
 * What a cell's tooltip leads with, under each lens:
 * - Activity: '14 activities: 1 task, 3 sessions, 10 messages'
 * - Tokens: '2.1M tokens: 1.9M cache read · 140k cache write · 12k input · 48k output'
 * - Cost: '$0.12 spent'
 * A day with activity but no ledger rows says 'No token data recorded' rather than suggesting it was
 * free, and a day with nothing at all says 'No activity'.
 */
export function cellSummary(day: DayUsage, lens: UsageLens): string {
	const activity = lensValue(day, 'activity')
	if (lens === 'activity') {
		if (activity === 0) return 'No activity'
		return `${plural(activity, 'activity', 'activities')}: ${plural(day.tasks, 'task')}, ${plural(day.sessions, 'session')}, ${plural(day.messages, 'message')}`
	}
	if (day.tokens === null || day.costUsd === null) return activity === 0 ? 'No activity' : NO_TOKEN_DATA
	return lens === 'tokens' ? tokenSummary(day.tokens) : `${formatCost(day.costUsd)} spent`
}

/** The cell's accessible name: the summary and the date. */
export function cellLabel(day: DayUsage, lens: UsageLens): string {
	return `${cellSummary(day, lens)} · ${formatDayLong(day.date)}`
}

/**
 * The line above the grid: the year's total, and the span it covers. With history shorter than the
 * grid (no activity in its first week), it says when it started: 'since Oct 3'.
 */
export function headline(days: readonly DayUsage[], lens: UsageLens): { total: string; span: string } {
	const total = days.reduce((sum, day) => sum + lensValue(day, lens), 0)
	const firstActive = days.findIndex((day) => lensValue(day, lens) > 0)
	const first = days[firstActive]
	const span =
		firstActive < 0 || firstActive < 7 || !first ? 'in the last year' : `since ${formatDayShort(first.date)}`
	return { total: formatTotal(total, lens), span }
}

/** The headline's figure: '1,284 activities', '48.2M tokens', '$612.40 spent'. */
function formatTotal(total: number, lens: UsageLens): string {
	if (lens === 'tokens') return `${formatTokenCount(total)} ${total === 1 ? 'token' : 'tokens'}`
	if (lens === 'cost') return `${formatCost(total)} spent`
	return plural(total, 'activity', 'activities')
}

/** Nothing to show under any lens: no activity, and no recorded usage either. */
export function isEmptyYear(days: readonly DayUsage[]): boolean {
	return days.every((day) => lensValue(day, 'activity') === 0 && day.tokens === null)
}

// ── Day list ─────────────────────────────────────────────────────────────────

/**
 * The day list's header count: '7 tasks', '2 tasks · 1 session', '1 session'. Nothing on an empty day,
 * whose card says so instead.
 */
export function dayListCount(rows: readonly UsageDayRow[]): string | null {
	const tasks = rows.filter((row) => row.kind === 'task').length
	const sessions = rows.length - tasks
	const parts = [tasks > 0 ? plural(tasks, 'task') : null, sessions > 0 ? plural(sessions, 'session') : null]
	const text = parts.filter(Boolean).join(' · ')
	return text || null
}

/**
 * What you did on a row that day: 'Created · 3 sessions · 10 messages' for a task, 'Started · 2 messages'
 * for a session with no task, whose own start is its one session. A row that only spent tokens that day
 * (a run that carried on from an earlier day) says 'Usage only'.
 */
export function dayRowMeta(row: UsageDayRow): string {
	const parts =
		row.kind === 'task'
			? [
					row.created ? 'Created' : null,
					row.sessions > 0 ? plural(row.sessions, 'session') : null,
					row.messages > 0 ? plural(row.messages, 'message') : null,
				]
			: [row.created ? 'Started' : null, row.messages > 0 ? plural(row.messages, 'message') : null]
	const text = parts.filter(Boolean).join(' · ')
	return text || 'Usage only'
}

// ── Period section ───────────────────────────────────────────────────────────

export const USAGE_PERIOD_OPTIONS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
	{ value: 'week', label: 'Week' },
	{ value: 'month', label: 'Month' },
	{ value: 'year', label: 'Year' },
]

/** The section's heading: each period runs to today. */
export function periodTitle(period: UsagePeriod): string {
	if (period === 'week') return 'This week'
	if (period === 'month') return 'This month'
	return 'Last 12 months'
}

/** What a period is compared with. */
function previousPeriodName(period: UsagePeriod): string {
	if (period === 'week') return 'last week'
	if (period === 'month') return 'last month'
	return 'the 12 months before'
}

/** Everything you did in a period, counted as the grid counts a day. */
export function periodActivities(totals: Pick<PeriodTotals, 'tasks' | 'sessions' | 'messages'>): number {
	return totals.tasks + totals.sessions + totals.messages
}

/** The Activities tile's breakdown: '9 tasks · 41 sessions · 136 messages'. */
export function periodActivityDetail(totals: Pick<PeriodTotals, 'tasks' | 'sessions' | 'messages'>): string {
	return [plural(totals.tasks, 'task'), plural(totals.sessions, 'session'), plural(totals.messages, 'message')].join(
		' · ',
	)
}

/**
 * How a period compares with the same stretch of the one before: '↑ 18% vs last month',
 * '↓ 5% vs last week', 'About the same as last month'. Nothing when either side has no token data, or
 * when the previous one is zero and a percentage would mean nothing.
 */
export function periodDelta(current: number | null, previous: number | null, period: UsagePeriod): string | null {
	if (current === null || previous === null || previous <= 0) return null
	const percent = Math.round(((current - previous) / previous) * 100)
	const name = previousPeriodName(period)
	if (percent === 0) return `About the same as ${name}`
	return `${percent > 0 ? '↑' : '↓'} ${count.format(Math.abs(percent))}% vs ${name}`
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** The Active days tile's footnote: 'most active: Tue', from a 0 = Monday weekday. */
export function topWeekdayLabel(weekday: number | null): string {
	return weekday === null ? 'No active days yet' : `most active: ${WEEKDAYS[weekday] ?? ''}`
}
