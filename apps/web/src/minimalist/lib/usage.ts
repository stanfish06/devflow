// Pure logic behind the usage page: the year grid's calendar layout, streaks, shading, the cost chart's
// bars and colours, and the words around them. The server computes every number; this only arranges and
// describes them.
import { dayOfWeek, parseDayKey } from '@devflow/api-contract/api/metrics/range'
import type { UsageDayRow } from '@devflow/api-contract/api/usage/day'
import type { PeriodBucket, PeriodModelCost, PeriodTotals } from '@devflow/api-contract/api/usage/period'
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

/** 'Nov 18' for a day key, whatever the browser's time zone. */
export function formatDayShort(key: string): string {
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

// ── Cost by model ────────────────────────────────────────────────────────────

/**
 * The model lines the chart colours. A year of history spans many model IDs, so colour follows the
 * family, and a model never changes colour from one period to the next.
 */
export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'

/** The chart's stacking order, bottom up, which is also the legend's order. */
export const FAMILY_ORDER: readonly ModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable', 'other']

/**
 * Each family's fixed slot of the product's `--chart-*` palette. The palette has one set of values for
 * both themes, and only five of its twelve stay inside the lightness band and clear 3:1 on both
 * minimalist surfaces (#ffffff and #0a0a0a): 1, 2, 9, 10 and 11. These four, in the stacking order
 * above, pass the dataviz validator in both modes: every neighbour at least ΔE 16 apart under protan and
 * deutan simulation and 19 apart to normal vision, with 2px surface gaps between segments on top. The
 * one weak pair is the two blues, Opus and Fable (ΔE 13 to normal vision), so they sit at opposite ends
 * of the stack and touch only in a bar holding neither Sonnet nor Haiku; the legend and the tooltip name
 * every segment. Anything else is the neutral ink, never a generated hue.
 */
const FAMILY_COLORS: Record<ModelFamily, string> = {
	opus: 'var(--chart-1)',
	sonnet: 'var(--chart-2)',
	haiku: 'var(--chart-11)',
	fable: 'var(--chart-9)',
	other: 'var(--fg-3)',
}

const FAMILY_LABELS: Record<ModelFamily, string> = {
	opus: 'Opus',
	sonnet: 'Sonnet',
	haiku: 'Haiku',
	fable: 'Fable',
	other: 'Other',
}

const FAMILY_PATTERN = /fable|opus|sonnet|haiku/

/** 'claude-opus-4-8' → 'opus'; the 'opus' alias and 'opus[1m]' too; anything unknown → 'other'. */
export function modelFamily(model: string): ModelFamily {
	const match = FAMILY_PATTERN.exec(model.toLowerCase())
	return match ? (match[0] as Exclude<ModelFamily, 'other'>) : 'other'
}

export function familyColor(family: ModelFamily): string {
	return FAMILY_COLORS[family]
}

/** A model's colour: its family's, so every version of Opus wears the same one. */
export function modelColor(model: string): string {
	return familyColor(modelFamily(model))
}

export function familyLabel(family: ModelFamily): string {
	return FAMILY_LABELS[family]
}

/** 'claude-opus-4-8', 'claude-opus-4-5-20251101' and 'opus-4-8[1m]'; and the older 'claude-3-5-sonnet-20241022'. */
const MODEL_ID = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(-1m|\[1m\])?$/
const LEGACY_MODEL_ID = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)(?:-\d{8})?$/

/**
 * A model ID as people say it: 'claude-opus-4-8' → 'Opus 4.8', 'claude-haiku-4-5-20251001' → 'Haiku 4.5',
 * 'opus' → 'Opus', 'claude-opus-4-6-1m' → 'Opus 4.6 1M'. An ID it can't read stays as it is.
 */
export function modelName(model: string): string {
	const id = model.trim().toLowerCase()
	const current = MODEL_ID.exec(id)
	if (current) {
		const [, family, major, minor, wide] = current
		const version = [major, minor].filter(Boolean).join('.')
		return [FAMILY_LABELS[family as ModelFamily], version, wide ? '1M' : ''].filter(Boolean).join(' ')
	}
	const legacy = LEGACY_MODEL_ID.exec(id)
	if (legacy) {
		const [, major, minor, family] = legacy
		return `${FAMILY_LABELS[family as ModelFamily]} ${[major, minor].filter(Boolean).join('.')}`
	}
	return model
}

/** One family's share of a bar. */
export type ChartSegment = { family: ModelFamily; costUsd: number }

/** One bar of the cost-by-model chart. */
export type ChartSlot = {
	/** The bucket's first day. */
	start: string
	/** After today: drawn as an empty slot, so an early-period chart keeps its width. */
	future: boolean
	/** No ledger rows in the bucket: "No cost recorded", not $0.00. */
	empty: boolean
	total: number
	/** Families with spend, bottom up in {@link FAMILY_ORDER}. */
	segments: ChartSegment[]
	/** Every model in the bucket, grouped by family in stacking order, the most expensive first within one. */
	models: Array<{ model: string; family: ModelFamily; costUsd: number }>
}

/** Clean steps for the chart's one gridline, per power of ten. */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const

/**
 * The chart's top: the smallest clean figure at or above the tallest bar, so the gridline reads '$0.20'
 * or '$8', never '$7.31'. Never below a cent; zero when nothing was spent.
 */
export function chartCeiling(value: number): number {
	if (value <= 0) return 0
	const target = Math.max(value, 0.01)
	const power = 10 ** Math.floor(Math.log10(target))
	// A hair of tolerance, so 0.3 (really 0.30000000000000004) tops out at 0.3 rather than 0.4.
	const step = NICE_STEPS.find((candidate) => candidate * power >= target * (1 - 1e-9)) ?? 10
	return step * power
}

/**
 * The chart's bars, one per slot of the period whether or not the server has answered yet: each with its
 * spend per family, bottom up in the fixed stacking order, and every model for the tooltip. `max` is the
 * clean figure the bars are scaled to and the gridline is drawn at.
 */
export function chartSlots(
	buckets: readonly PeriodBucket[] | undefined,
	slots: readonly string[],
	today: string,
): { slots: ChartSlot[]; max: number } {
	const byStart = new Map((buckets ?? []).map((bucket) => [bucket.start, bucket.costByModel]))
	const shaped = slots.map((start): ChartSlot => {
		const costByModel = byStart.get(start) ?? {}
		const models = Object.entries(costByModel)
			.map(([model, costUsd]) => ({ model, family: modelFamily(model), costUsd }))
			.sort(
				(a, b) =>
					FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
					b.costUsd - a.costUsd ||
					a.model.localeCompare(b.model),
			)
		const segments = FAMILY_ORDER.map((family) => ({
			family,
			costUsd: models.filter((entry) => entry.family === family).reduce((sum, entry) => sum + entry.costUsd, 0),
		})).filter((segment) => segment.costUsd > 0)
		return {
			start,
			// Day keys order as text.
			future: start > today,
			empty: models.length === 0,
			total: models.reduce((sum, entry) => sum + entry.costUsd, 0),
			segments,
			models,
		}
	})
	return { slots: shaped, max: chartCeiling(Math.max(0, ...shaped.map((slot) => slot.total))) }
}

/** The families a period spent on, in stacking order: the chart's legend. */
export function chartFamilies(byModel: readonly PeriodModelCost[]): ModelFamily[] {
	const present = new Set(byModel.map((row) => modelFamily(row.model)))
	return FAMILY_ORDER.filter((family) => present.has(family))
}

/** The chart's heading: a bar a day for the week and month, a bar a month for the year. */
export function chartTitle(period: UsagePeriod): string {
	return period === 'year' ? 'Monthly cost by model' : 'Daily cost by model'
}

/** A bar's date under the axis: 'Nov 18' for a day, 'Nov 2026' for the year's months. */
export function slotLabel(start: string, period: UsagePeriod): string {
	if (period !== 'year') return formatDayShort(start)
	return new Date(parseDayKey(start) ?? 0).toLocaleDateString('en-US', {
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** A bar's date in its tooltip: 'Wed, Nov 18, 2026' for a day, 'November 2026' for a month. */
export function slotTitle(start: string, period: UsagePeriod): string {
	if (period !== 'year') return formatDayLong(start)
	return new Date(parseDayKey(start) ?? 0).toLocaleDateString('en-US', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** What a bar says first: its total, or that nothing was recorded, which never reads as free. */
export function slotSummary(slot: ChartSlot): string {
	return slot.empty ? 'No cost recorded' : formatCost(slot.total)
}

/** A bar's accessible name: 'Wed, Nov 18, 2026: $0.12 · Opus 4.5 $0.10 · Haiku 4.5 $0.02'. */
export function slotAccessibleName(slot: ChartSlot, period: UsagePeriod): string {
	const models = slot.models.map((entry) => `${modelName(entry.model)} ${formatCost(entry.costUsd)}`)
	return [`${slotTitle(slot.start, period)}: ${slotSummary(slot)}`, ...models].join(' · ')
}

/** The gridline's figure: cents while small, whole dollars from $10: '$0.20', '$2.50', '$150'. */
export function formatAxisCost(usd: number): string {
	if (usd >= 10) return `$${count.format(Math.round(usd))}`
	return dollars.format(usd)
}

/** A model's share of the period's spend, 0–1, for the by-model list's bars. */
export function costShare(costUsd: number, byModel: readonly PeriodModelCost[]): number {
	const total = byModel.reduce((sum, row) => sum + row.costUsd, 0)
	return total > 0 ? costUsd / total : 0
}
