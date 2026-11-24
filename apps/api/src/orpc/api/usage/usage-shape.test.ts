import { describe, expect, it } from 'vitest'

import { zeroFillDays } from './usage-shape'

describe('zeroFillDays', () => {
	const window = { from: '2026-11-16', to: '2026-11-19' }

	it('returns one ascending entry per day of the window, zero where nothing happened', () => {
		const days = zeroFillDays([{ day: '2026-11-18', tasks: 1, sessions: 3, messages: 10 }], window)
		expect(days).toEqual([
			{ date: '2026-11-16', tasks: 0, sessions: 0, messages: 0 },
			{ date: '2026-11-17', tasks: 0, sessions: 0, messages: 0 },
			{ date: '2026-11-18', tasks: 1, sessions: 3, messages: 10 },
			{ date: '2026-11-19', tasks: 0, sessions: 0, messages: 0 },
		])
	})

	it('reads counts the driver returns as text', () => {
		const [day] = zeroFillDays([{ day: '2026-11-16', tasks: '2', sessions: '0', messages: '7' }], {
			from: '2026-11-16',
			to: '2026-11-16',
		})
		expect(day).toEqual({ date: '2026-11-16', tasks: 2, sessions: 0, messages: 7 })
	})

	it('drops rows outside the window instead of growing the grid', () => {
		const days = zeroFillDays(
			[
				{ day: '2026-11-15', tasks: 9, sessions: 9, messages: 9 },
				{ day: '2026-11-20', tasks: 9, sessions: 9, messages: 9 },
			],
			window,
		)
		expect(days.map((day) => day.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'])
		expect(days.every((day) => day.tasks + day.sessions + day.messages === 0)).toBe(true)
	})

	it('spans a full year grid with no gaps', () => {
		const days = zeroFillDays([], { from: '2025-11-24', to: '2026-11-24' })
		expect(days).toHaveLength(366)
		expect(days[0]?.date).toBe('2025-11-24')
		expect(days.at(-1)?.date).toBe('2026-11-24')
	})
})
