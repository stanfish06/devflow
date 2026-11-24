import { addDays, rangeLengthDays } from '@devflow/api-contract/api/metrics/range'
import type { UsageDayRow } from '@devflow/api-contract/api/usage/day'
import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage } from '@devflow/api-contract/api/usage/year'
import { describe, expect, it } from 'vitest'

import {
	cellLabel,
	cellSummary,
	dayListCount,
	dayRowMeta,
	formatCost,
	formatTokenCount,
	gridLayout,
	headline,
	intensityLevel,
	intensityThresholds,
	isEmptyYear,
	lensValue,
	localDayKey,
	streaks,
} from '@/minimalist/lib/usage'

const noUsage = { tokens: null, costUsd: null }

/** A dense run of days ending on `to`, with activity counts (as messages) from `values`. */
function run(to: string, values: number[]): DayUsage[] {
	return values.map((messages, index) => ({
		date: addDays(to, index - values.length + 1),
		tasks: 0,
		sessions: 0,
		messages,
		...noUsage,
	}))
}

/** The year grid's days for `today`, all empty unless `active` names some, or `usage` gives some cost. */
function year(today: string, active: Record<string, number> = {}, usage: Record<string, number> = {}): DayUsage[] {
	const { from } = yearWindow(today)
	const length = rangeLengthDays(yearWindow(today)) ?? 0
	return Array.from({ length }, (_, index) => {
		const date = addDays(from, index)
		const cost = usage[date]
		return {
			date,
			tasks: 0,
			sessions: 0,
			messages: active[date] ?? 0,
			...(cost === undefined
				? noUsage
				: { tokens: { cacheRead: 600, cacheWrite: 100, input: 400, output: 100 }, costUsd: cost }),
		}
	})
}

/** The fixture day: one Claude task, session and prompt, 1,200 tokens for $0.12. */
const claudeDay: DayUsage = {
	date: '2026-11-18',
	tasks: 1,
	sessions: 1,
	messages: 1,
	tokens: { cacheRead: 600, cacheWrite: 100, input: 400, output: 100 },
	costUsd: 0.12,
}

describe('localDayKey', () => {
	it('reads the local calendar day', () => {
		expect(localDayKey(new Date(2026, 10, 4, 23, 59))).toBe('2026-11-04')
		expect(localDayKey(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01')
	})
})

describe('lensValue', () => {
	it('counts tasks, sessions and messages as activities', () => {
		expect(lensValue({ date: '2026-11-18', tasks: 1, sessions: 3, messages: 10, ...noUsage }, 'activity')).toBe(14)
	})

	it('counts every token kind, cache reads included, to match the session badge', () => {
		expect(lensValue(claudeDay, 'tokens')).toBe(1200)
		expect(lensValue(claudeDay, 'cost')).toBe(0.12)
	})

	it('reads a day without token data as zero, for shading and totals', () => {
		const codexDay = { ...claudeDay, ...noUsage }
		expect(lensValue(codexDay, 'tokens')).toBe(0)
		expect(lensValue(codexDay, 'cost')).toBe(0)
		expect(lensValue(codexDay, 'activity')).toBe(3)
	})
})

describe('formatTokenCount', () => {
	it('stays exact while small, then shortens', () => {
		expect(formatTokenCount(0)).toBe('0')
		expect(formatTokenCount(1200)).toBe('1,200')
		expect(formatTokenCount(9999)).toBe('9,999')
		expect(formatTokenCount(12_000)).toBe('12k')
		expect(formatTokenCount(140_400)).toBe('140k')
		expect(formatTokenCount(2_100_000)).toBe('2.1M')
		expect(formatTokenCount(48_240_000)).toBe('48.2M')
		expect(formatTokenCount(3_400_000_000)).toBe('3.4B')
	})

	it('never reads as 1000 of a smaller unit', () => {
		expect(formatTokenCount(999_600)).toBe('1M')
		expect(formatTokenCount(999_960_000)).toBe('1B')
	})
})

describe('formatCost', () => {
	it('shows dollars to the cent', () => {
		expect(formatCost(0.12)).toBe('$0.12')
		expect(formatCost(612.4)).toBe('$612.40')
		expect(formatCost(1612.399)).toBe('$1,612.40')
		expect(formatCost(0)).toBe('$0.00')
	})

	it("doesn't round a real spend down to nothing", () => {
		expect(formatCost(0.001)).toBe('<$0.01')
	})
})

describe('gridLayout', () => {
	it('lays the year out in 53 Monday-first columns ending today', () => {
		// Tuesday: the last column holds Monday and Tuesday only.
		const { weeks } = gridLayout(year('2026-11-24'))
		expect(weeks).toHaveLength(53)
		expect(weeks.slice(0, 52).every((week) => week.length === 7)).toBe(true)
		expect(weeks.at(-1)?.map((cell) => cell.day.date)).toEqual(['2026-11-23', '2026-11-24'])
		expect(weeks[0]?.map((cell) => cell.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
		expect(weeks[0]?.[0]?.day.date).toBe('2025-11-24')
	})

	it('has a full last column on a Sunday', () => {
		const { weeks } = gridLayout(year('2026-11-29'))
		expect(weeks).toHaveLength(53)
		expect(weeks.at(-1)).toHaveLength(7)
	})

	it("labels each month over its first Monday column, skipping the grid's partial first month", () => {
		const { weeks, months } = gridLayout(year('2026-11-24'))
		// The grid opens on Mon Nov 24, 2025, too late in November to label without crowding December.
		expect(months[0]).toEqual({ column: 1, label: 'Dec' })
		expect(weeks[1]?.[0]?.day.date).toBe('2025-12-01')
		expect(months.map((month) => month.label)).toEqual([
			'Dec',
			'Jan',
			'Feb',
			'Mar',
			'Apr',
			'May',
			'Jun',
			'Jul',
			'Aug',
			'Sep',
			'Oct',
			'Nov',
		])
		for (const { column } of months) expect(Number(weeks[column]?.[0]?.day.date.slice(8))).toBeLessThanOrEqual(7)
	})
})

describe('streaks', () => {
	it('counts the run ending today', () => {
		expect(streaks(run('2026-11-24', [0, 1, 2, 3]))).toEqual({ current: 3, longest: 3 })
	})

	it('still counts a run ending yesterday when today has nothing yet', () => {
		expect(streaks(run('2026-11-24', [1, 1, 0]))).toEqual({ current: 2, longest: 2 })
	})

	it('drops to zero once yesterday is empty too', () => {
		expect(streaks(run('2026-11-24', [1, 1, 1, 0, 0]))).toEqual({ current: 0, longest: 3 })
	})

	it('keeps the longest run from earlier in the year', () => {
		expect(streaks(run('2026-11-24', [1, 1, 1, 1, 0, 1, 1]))).toEqual({ current: 2, longest: 4 })
		expect(streaks([])).toEqual({ current: 0, longest: 0 })
	})
})

describe('intensity', () => {
	it('cuts at the quartiles of the non-zero days', () => {
		expect(intensityThresholds([0, 0, 1, 2, 2, 3, 5, 8, 14, 40])).toEqual([2, 4, 11])
	})

	it('maps a typical day to a middle shade and an outlier to the darkest', () => {
		const thresholds = intensityThresholds([1, 2, 2, 3, 5, 8, 14, 40])
		expect([0, 1, 2, 3, 5, 11, 12, 40].map((value) => intensityLevel(value, thresholds))).toEqual([
			0, 1, 1, 2, 3, 3, 4, 4,
		])
	})

	it('keeps an outlier from washing everything else out', () => {
		const thresholds = intensityThresholds([1, 2, 3, 4, 5, 6, 7, 1000])
		expect(intensityLevel(6, thresholds)).toBe(3)
		expect(intensityLevel(1000, thresholds)).toBe(4)
	})

	it('handles a year with one or no active days', () => {
		expect(intensityThresholds([])).toEqual([0, 0, 0])
		expect(intensityLevel(0, intensityThresholds([]))).toBe(0)
		expect(intensityLevel(5, intensityThresholds([5]))).toBe(1)
	})
})

describe('words', () => {
	const day = { date: '2026-11-18', tasks: 1, sessions: 3, messages: 10, ...noUsage }

	it('breaks a cell down by kind', () => {
		expect(cellSummary(day, 'activity')).toBe('14 activities: 1 task, 3 sessions, 10 messages')
		expect(cellLabel(day, 'activity')).toBe('14 activities: 1 task, 3 sessions, 10 messages · Wed, Nov 18, 2026')
		expect(cellSummary({ ...day, tasks: 0, sessions: 1, messages: 0 }, 'activity')).toBe(
			'1 activity: 0 tasks, 1 session, 0 messages',
		)
		expect(cellLabel({ ...day, tasks: 0, sessions: 0, messages: 0 }, 'activity')).toBe(
			'No activity · Wed, Nov 18, 2026',
		)
	})

	it('breaks a day down by token kind under the Tokens lens', () => {
		expect(cellSummary(claudeDay, 'tokens')).toBe(
			'1,200 tokens: 600 cache read · 100 cache write · 400 input · 100 output',
		)
		expect(
			cellSummary(
				{
					...claudeDay,
					tokens: { cacheRead: 1_900_000, cacheWrite: 140_000, input: 12_000, output: 48_000 },
				},
				'tokens',
			),
		).toBe('2.1M tokens: 1.9M cache read · 140k cache write · 12k input · 48k output')
	})

	it('shows the spend under the Cost lens', () => {
		expect(cellSummary(claudeDay, 'cost')).toBe('$0.12 spent')
		expect(cellLabel(claudeDay, 'cost')).toBe('$0.12 spent · Wed, Nov 18, 2026')
	})

	it('says a day with activity but no ledger rows has no token data, never $0.00', () => {
		const codexDay = { ...claudeDay, ...noUsage }
		expect(cellSummary(codexDay, 'tokens')).toBe('No token data recorded')
		expect(cellSummary(codexDay, 'cost')).toBe('No token data recorded')
		// A day with nothing at all is plainly empty under every lens.
		const quiet = { ...codexDay, tasks: 0, sessions: 0, messages: 0 }
		expect(cellSummary(quiet, 'tokens')).toBe('No activity')
		expect(cellSummary(quiet, 'cost')).toBe('No activity')
	})

	it('shows a real zero when ledger rows exist but cost nothing', () => {
		const free = { ...claudeDay, tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }, costUsd: 0 }
		expect(cellSummary(free, 'cost')).toBe('$0.00 spent')
		expect(cellSummary(free, 'tokens')).toBe('0 tokens: 0 cache read · 0 cache write · 0 input · 0 output')
	})

	it('totals the year in the headline', () => {
		const days = year('2026-11-24', { '2025-11-25': 1200, '2026-11-18': 84 })
		expect(headline(days, 'activity')).toEqual({ total: '1,284 activities', span: 'in the last year' })
	})

	it('says when a short history started', () => {
		const days = year('2026-11-24', { '2026-10-03': 1, '2026-11-18': 2 })
		expect(headline(days, 'activity')).toEqual({ total: '3 activities', span: 'since Oct 3' })
	})

	it('reads zero with no history at all', () => {
		expect(headline(year('2026-11-24'), 'activity')).toEqual({ total: '0 activities', span: 'in the last year' })
	})

	it('totals tokens and cost in the headline', () => {
		const days = year('2026-11-24', { '2025-11-25': 3, '2026-11-18': 3 }, { '2025-11-25': 0.3, '2026-11-18': 0.12 })
		expect(headline(days, 'tokens')).toEqual({ total: '2,400 tokens', span: 'in the last year' })
		expect(headline(days, 'cost')).toEqual({ total: '$0.42 spent', span: 'in the last year' })
	})

	it('dates a short token history from its first recorded day', () => {
		const days = year('2026-11-24', { '2026-01-05': 1, '2026-10-03': 1 }, { '2026-10-03': 0.12 })
		expect(headline(days, 'activity').span).toBe('since Jan 5')
		expect(headline(days, 'tokens')).toEqual({ total: '1,200 tokens', span: 'since Oct 3' })
	})
})

describe('isEmptyYear', () => {
	it('is empty only with no activity and no recorded usage', () => {
		expect(isEmptyYear(year('2026-11-24'))).toBe(true)
		expect(isEmptyYear(year('2026-11-24', { '2026-11-18': 1 }))).toBe(false)
		expect(isEmptyYear(year('2026-11-24', {}, { '2026-11-18': 0 }))).toBe(false)
	})
})

describe('day list', () => {
	const row = (overrides: Partial<UsageDayRow>): UsageDayRow => ({
		kind: 'task',
		id: 'id',
		name: 'Usage dashboard',
		archived: false,
		created: false,
		sessions: 0,
		messages: 0,
		tokens: null,
		costUsd: null,
		...overrides,
	})

	it('counts tasks and task-less sessions in the header', () => {
		expect(dayListCount([])).toBeNull()
		expect(dayListCount([row({}), row({})])).toBe('2 tasks')
		expect(dayListCount([row({}), row({ kind: 'session' })])).toBe('1 task · 1 session')
		expect(dayListCount([row({ kind: 'session' }), row({ kind: 'session' })])).toBe('2 sessions')
	})

	it('says what you did on a task', () => {
		expect(dayRowMeta(row({ created: true, sessions: 3, messages: 10 }))).toBe('Created · 3 sessions · 10 messages')
		expect(dayRowMeta(row({ sessions: 1, messages: 1 }))).toBe('1 session · 1 message')
		expect(dayRowMeta(row({ messages: 2 }))).toBe('2 messages')
	})

	it('says a task-less session was started, without counting itself as a session', () => {
		expect(dayRowMeta(row({ kind: 'session', created: true, sessions: 1, messages: 2 }))).toBe(
			'Started · 2 messages',
		)
		expect(dayRowMeta(row({ kind: 'session', created: true, sessions: 1 }))).toBe('Started')
	})

	it('marks a row that only spent tokens that day', () => {
		expect(dayRowMeta(row({ kind: 'session', tokens: 10, costUsd: 0.01 }))).toBe('Usage only')
	})
})
