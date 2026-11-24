import { addDays, rangeLengthDays } from '@devflow/api-contract/api/metrics/range'
import { yearWindow } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage } from '@devflow/api-contract/api/usage/year'
import { describe, expect, it } from 'vitest'

import {
	cellLabel,
	cellSummary,
	gridLayout,
	headline,
	intensityLevel,
	intensityThresholds,
	lensValue,
	localDayKey,
	streaks,
} from '@/minimalist/lib/usage'

/** A dense run of days ending on `to`, with activity counts (as messages) from `values`. */
function run(to: string, values: number[]): DayUsage[] {
	return values.map((messages, index) => ({
		date: addDays(to, index - values.length + 1),
		tasks: 0,
		sessions: 0,
		messages,
	}))
}

/** The year grid's days for `today`, all empty unless `active` names some. */
function year(today: string, active: Record<string, number> = {}): DayUsage[] {
	const { from } = yearWindow(today)
	const length = rangeLengthDays(yearWindow(today)) ?? 0
	return Array.from({ length }, (_, index) => {
		const date = addDays(from, index)
		return { date, tasks: 0, sessions: 0, messages: active[date] ?? 0 }
	})
}

describe('localDayKey', () => {
	it('reads the local calendar day', () => {
		expect(localDayKey(new Date(2026, 10, 4, 23, 59))).toBe('2026-11-04')
		expect(localDayKey(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01')
	})
})

describe('lensValue', () => {
	it('counts tasks, sessions and messages as activities', () => {
		expect(lensValue({ date: '2026-11-18', tasks: 1, sessions: 3, messages: 10 }, 'activity')).toBe(14)
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
	const day = { date: '2026-11-18', tasks: 1, sessions: 3, messages: 10 }

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
})
