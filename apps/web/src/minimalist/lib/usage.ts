// Pure logic behind the usage page: the year grid's calendar layout, streaks, shading and the words
// around them. The server computes every number; this only arranges and describes them.
import { dayOfWeek, parseDayKey } from '@devflow/api-contract/api/metrics/range'
import type { DayUsage } from '@devflow/api-contract/api/usage/year'

/** What the grid's cells measure. Tokens and Cost arrive with the usage ledger fields. */
export type UsageLens = 'activity'

export type IntensityLevel = 0 | 1 | 2 | 3 | 4
export type Thresholds = [number, number, number]

/** The local calendar day of `date` as 'YYYY-MM-DD'. */
export function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

/** A day's value under a lens. */
export function lensValue(day: DayUsage, _lens: UsageLens): number {
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

/** What a cell's tooltip leads with: '14 activities: 1 task, 3 sessions, 10 messages', or 'No activity'. */
export function cellSummary(day: DayUsage, lens: UsageLens): string {
	const total = lensValue(day, lens)
	if (total === 0) return 'No activity'
	return `${plural(total, 'activity', 'activities')}: ${plural(day.tasks, 'task')}, ${plural(day.sessions, 'session')}, ${plural(day.messages, 'message')}`
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
	return { total: plural(total, 'activity', 'activities'), span }
}
