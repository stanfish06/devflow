import { describe, expect, it } from 'vitest'

import { dayOfWeek, rangeLengthDays } from '../src/api/metrics/range'
import { DayKeySchema, periodWindows, UsagePeriodSchema, yearWindow } from '../src/api/usage/windows'

describe('yearWindow', () => {
	it('starts on the Monday 52 weeks before this week and ends today', () => {
		// 2026-11-24 is a Tuesday; this week's Monday is Nov 23.
		expect(yearWindow('2026-11-24')).toEqual({ from: '2025-11-24', to: '2026-11-24' })
	})

	it('always has 53 week columns, whatever the weekday', () => {
		// Monday 2026-11-23 through Sunday 2026-11-29.
		for (let day = 23; day <= 29; day++) {
			const today = `2026-11-${day}`
			const { from, to } = yearWindow(today)
			expect(dayOfWeek(from)).toBe(0)
			expect(to).toBe(today)
			const days = rangeLengthDays({ from, to }) ?? 0
			expect(Math.ceil(days / 7)).toBe(53)
			// 52 whole weeks plus however much of this week has happened.
			expect(days).toBe(52 * 7 + (dayOfWeek(today) ?? 0) + 1)
		}
	})

	it('counts weeks, not calendar days, across a leap day', () => {
		// The window covering Feb 29, 2028 still starts on a Monday, 364 days before this week's Monday.
		expect(yearWindow('2028-03-01')).toEqual({ from: '2027-03-01', to: '2028-03-01' })
		expect(dayOfWeek('2027-03-01')).toBe(0)
		expect(rangeLengthDays(yearWindow('2028-03-01'))).toBe(52 * 7 + 3)
	})

	it('crosses a year boundary', () => {
		// Friday 2027-01-01; that week's Monday is 2026-12-28.
		expect(yearWindow('2027-01-01')).toEqual({ from: '2025-12-29', to: '2027-01-01' })
	})
})

describe('DayKeySchema', () => {
	it('accepts real calendar days only', () => {
		expect(DayKeySchema.safeParse('2028-02-29').success).toBe(true)
		expect(DayKeySchema.safeParse('2026-02-29').success).toBe(false)
		expect(DayKeySchema.safeParse('2026-2-3').success).toBe(false)
		expect(DayKeySchema.safeParse('yesterday').success).toBe(false)
	})
})

describe('periodWindows', () => {
	describe('week', () => {
		it('runs Monday to today, against last Monday to the same weekday', () => {
			// Tuesday 2026-11-24.
			const { current, previous, slots } = periodWindows('week', '2026-11-24')
			expect(current).toEqual({ from: '2026-11-23', to: '2026-11-24' })
			expect(previous).toEqual({ from: '2026-11-16', to: '2026-11-17' })
			expect(slots).toEqual([
				'2026-11-23',
				'2026-11-24',
				'2026-11-25',
				'2026-11-26',
				'2026-11-27',
				'2026-11-28',
				'2026-11-29',
			])
		})

		it('is a single day on a Monday and a whole week on a Sunday', () => {
			expect(periodWindows('week', '2026-11-23').current).toEqual({ from: '2026-11-23', to: '2026-11-23' })
			expect(periodWindows('week', '2026-11-29')).toMatchObject({
				current: { from: '2026-11-23', to: '2026-11-29' },
				previous: { from: '2026-11-16', to: '2026-11-22' },
			})
		})

		it('crosses a year boundary', () => {
			// Friday 2027-01-01.
			const { current, previous, slots } = periodWindows('week', '2027-01-01')
			expect(current).toEqual({ from: '2026-12-28', to: '2027-01-01' })
			expect(previous).toEqual({ from: '2026-12-21', to: '2026-12-25' })
			expect(slots.at(-1)).toBe('2027-01-03')
		})
	})

	describe('month', () => {
		it('runs from the 1st to today, against last month to the same day', () => {
			const { current, previous, slots } = periodWindows('month', '2026-11-24')
			expect(current).toEqual({ from: '2026-11-01', to: '2026-11-24' })
			expect(previous).toEqual({ from: '2026-10-01', to: '2026-10-24' })
			// Every day of November, the future ones included.
			expect(slots).toHaveLength(30)
			expect(slots[0]).toBe('2026-11-01')
			expect(slots.at(-1)).toBe('2026-11-30')
		})

		it('clamps the comparison to a shorter previous month', () => {
			expect(periodWindows('month', '2026-03-31').previous).toEqual({ from: '2026-02-01', to: '2026-02-28' })
			expect(periodWindows('month', '2026-03-29').previous).toEqual({ from: '2026-02-01', to: '2026-02-28' })
			expect(periodWindows('month', '2028-03-31').previous).toEqual({ from: '2028-02-01', to: '2028-02-29' })
			expect(periodWindows('month', '2026-05-31').previous).toEqual({ from: '2026-04-01', to: '2026-04-30' })
		})

		it('has a slot for every day of the month', () => {
			expect(periodWindows('month', '2026-02-10').slots).toHaveLength(28)
			expect(periodWindows('month', '2028-02-10').slots).toHaveLength(29)
			expect(periodWindows('month', '2026-12-01').slots).toHaveLength(31)
		})

		it('compares January with last December', () => {
			const { current, previous } = periodWindows('month', '2027-01-15')
			expect(current).toEqual({ from: '2027-01-01', to: '2027-01-15' })
			expect(previous).toEqual({ from: '2026-12-01', to: '2026-12-15' })
		})

		it('is a single day on the 1st', () => {
			expect(periodWindows('month', '2026-11-01')).toMatchObject({
				current: { from: '2026-11-01', to: '2026-11-01' },
				previous: { from: '2026-10-01', to: '2026-10-01' },
			})
		})
	})

	describe('year', () => {
		it('runs from the 1st, eleven months back, against the twelve months before to the same day', () => {
			const { current, previous } = periodWindows('year', '2026-11-24')
			expect(current).toEqual({ from: '2025-12-01', to: '2026-11-24' })
			expect(previous).toEqual({ from: '2024-12-01', to: '2025-11-24' })
		})

		it('has twelve month-start slots ending with this month', () => {
			const { slots } = periodWindows('year', '2026-11-24')
			expect(slots).toEqual([
				'2025-12-01',
				'2026-01-01',
				'2026-02-01',
				'2026-03-01',
				'2026-04-01',
				'2026-05-01',
				'2026-06-01',
				'2026-07-01',
				'2026-08-01',
				'2026-09-01',
				'2026-10-01',
				'2026-11-01',
			])
		})

		it('clamps the comparison on a leap day', () => {
			const { current, previous } = periodWindows('year', '2028-02-29')
			expect(current).toEqual({ from: '2027-03-01', to: '2028-02-29' })
			expect(previous).toEqual({ from: '2026-03-01', to: '2027-02-28' })
		})

		it('never overlaps the current window and ends right before it on the last day of a month', () => {
			const { current, previous } = periodWindows('year', '2026-11-30')
			expect(previous.to).toBe('2025-11-30')
			expect(current.from).toBe('2025-12-01')
		})
	})

	it('validates the period names', () => {
		expect(UsagePeriodSchema.safeParse('month').success).toBe(true)
		expect(UsagePeriodSchema.safeParse('day').success).toBe(false)
	})
})
