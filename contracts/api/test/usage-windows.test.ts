import { describe, expect, it } from 'vitest'

import { dayOfWeek, rangeLengthDays } from '../src/api/metrics/range'
import { DayKeySchema, yearWindow } from '../src/api/usage/windows'

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
