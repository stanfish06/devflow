import { describe, expect, it } from 'vitest'

import { buildDayRows, type DayItemRow, ledgerUsage, sumTotals, zeroFillDays } from './usage-shape'

const none = { tokens: null, costUsd: null }

describe('zeroFillDays', () => {
	const window = { from: '2026-11-16', to: '2026-11-19' }

	it('returns one ascending entry per day of the window, empty where nothing happened', () => {
		const days = zeroFillDays([{ day: '2026-11-18', tasks: 1, sessions: 3, messages: 10 }], window)
		expect(days).toEqual([
			{ date: '2026-11-16', tasks: 0, sessions: 0, messages: 0, ...none },
			{ date: '2026-11-17', tasks: 0, sessions: 0, messages: 0, ...none },
			{ date: '2026-11-18', tasks: 1, sessions: 3, messages: 10, ...none },
			{ date: '2026-11-19', tasks: 0, sessions: 0, messages: 0, ...none },
		])
	})

	it('reads counts and sums the driver returns as text', () => {
		const [day] = zeroFillDays(
			[
				{
					day: '2026-11-16',
					tasks: '2',
					sessions: '0',
					messages: '7',
					ledger_rows: '1',
					cache_read: '600',
					cache_write: '100',
					input: '400',
					output: '100',
					cost_usd: '0.12',
				},
			],
			{ from: '2026-11-16', to: '2026-11-16' },
		)
		expect(day).toEqual({
			date: '2026-11-16',
			tasks: 2,
			sessions: 0,
			messages: 7,
			tokens: { cacheRead: 600, cacheWrite: 100, input: 400, output: 100 },
			costUsd: 0.12,
		})
	})

	it('carries usage on a day with no activity of its own', () => {
		const [day] = zeroFillDays(
			[
				{
					day: '2026-11-16',
					tasks: null,
					sessions: null,
					messages: null,
					ledger_rows: 2,
					cache_read: 10,
					cache_write: 0,
					input: 5,
					output: 1,
					cost_usd: 0.5,
				},
			],
			{ from: '2026-11-16', to: '2026-11-16' },
		)
		expect(day).toEqual({
			date: '2026-11-16',
			tasks: 0,
			sessions: 0,
			messages: 0,
			tokens: { cacheRead: 10, cacheWrite: 0, input: 5, output: 1 },
			costUsd: 0.5,
		})
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

describe('ledgerUsage', () => {
	it('is null, not zero, when there are no ledger rows', () => {
		expect(ledgerUsage(undefined)).toEqual(none)
		expect(ledgerUsage({ ledger_rows: 0, cache_read: null, cost_usd: null })).toEqual(none)
		expect(ledgerUsage({ ledger_rows: null })).toEqual(none)
	})

	it('is a real zero when rows exist and sum to nothing', () => {
		expect(
			ledgerUsage({ ledger_rows: 1, cache_read: 0, cache_write: 0, input: 0, output: 0, cost_usd: 0 }),
		).toEqual({ tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }, costUsd: 0 })
	})

	it('counts a missing cost as zero once rows exist, so the tokens still show', () => {
		expect(
			ledgerUsage({ ledger_rows: 1, cache_read: 0, cache_write: 0, input: 3, output: 4, cost_usd: null }),
		).toEqual({ tokens: { cacheRead: 0, cacheWrite: 0, input: 3, output: 4 }, costUsd: 0 })
	})
})

describe('sumTotals', () => {
	// Mon Nov 16 – Tue Nov 24, 2026.
	const window = { from: '2026-11-16', to: '2026-11-24' }
	const ledger = (cost: number) => ({
		ledger_rows: 1,
		cache_read: 600,
		cache_write: 100,
		input: 400,
		output: 100,
		cost_usd: cost,
	})

	it('adds up the days inside the window and ignores the rest', () => {
		const totals = sumTotals(
			[
				{ day: '2026-11-15', tasks: 9, sessions: 9, messages: 9, ...ledger(9) },
				{ day: '2026-11-18', tasks: 1, sessions: 1, messages: 2, ...ledger(0.12) },
				{ day: '2026-11-19', tasks: '0', sessions: '1', messages: '0', ...ledger(0.05) },
				{ day: '2026-11-25', tasks: 9, sessions: 9, messages: 9, ...ledger(9) },
			],
			window,
		)
		expect(totals).toMatchObject({
			tasks: 1,
			sessions: 2,
			messages: 2,
			tokens: { cacheRead: 1200, cacheWrite: 200, input: 800, output: 200 },
			activeDays: 2,
			elapsedDays: 9,
		})
		expect(totals.costUsd).toBeCloseTo(0.17)
	})

	it('reports no ledger rows as null, never zero', () => {
		const totals = sumTotals([{ day: '2026-11-18', tasks: 1, sessions: 1, messages: 0 }], window)
		expect(totals).toMatchObject({ tokens: null, costUsd: null, activeDays: 1 })
	})

	it('keeps a real zero when ledger rows exist but cost nothing', () => {
		const totals = sumTotals(
			[
				{
					day: '2026-11-18',
					tasks: 0,
					sessions: 1,
					messages: 0,
					ledger_rows: 1,
					cache_read: 0,
					cache_write: 0,
					input: 0,
					output: 0,
					cost_usd: null,
				},
			],
			window,
		)
		expect(totals).toMatchObject({ tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }, costUsd: 0 })
	})

	it("doesn't count a day that only spent tokens as active", () => {
		const totals = sumTotals(
			[{ day: '2026-11-18', tasks: null, sessions: null, messages: null, ...ledger(1) }],
			window,
		)
		expect(totals).toMatchObject({ activeDays: 0, topWeekday: null, costUsd: 1 })
	})

	it('names the weekday with the most activities, the earlier one on a tie', () => {
		const rows = [
			// Monday, twice, 2 + 3.
			{ day: '2026-11-16', tasks: 0, sessions: 1, messages: 1 },
			{ day: '2026-11-23', tasks: 0, sessions: 1, messages: 2 },
			// Wednesday, 6.
			{ day: '2026-11-18', tasks: 1, sessions: 1, messages: 4 },
		]
		expect(sumTotals(rows, window).topWeekday).toBe(2)
		// Monday's 5 against Wednesday's 5: Monday comes first.
		const tie = [...rows.slice(0, 2), { day: '2026-11-18', tasks: 0, sessions: 1, messages: 4 }]
		expect(sumTotals(tie, window).topWeekday).toBe(0)
	})

	it('is all zeros and nulls for an empty window', () => {
		expect(sumTotals([], { from: '2026-11-01', to: '2026-11-24' })).toEqual({
			tasks: 0,
			sessions: 0,
			messages: 0,
			tokens: null,
			costUsd: null,
			activeDays: 0,
			elapsedDays: 24,
			topWeekday: null,
		})
	})
})

describe('buildDayRows', () => {
	const item = (overrides: Partial<DayItemRow> & Pick<DayItemRow, 'id'>): DayItemRow => ({
		kind: 'task',
		name: `Task ${overrides.id}`,
		archived: false,
		created: false,
		sessions: 0,
		messages: 0,
		ledger_rows: 0,
		tokens: null,
		cost_usd: null,
		...overrides,
	})

	it('shapes a task row, with the null rule for a row without ledger rows', () => {
		const [row] = buildDayRows([item({ id: 't1', created: true, sessions: '3', messages: '10' })])
		expect(row).toEqual({
			kind: 'task',
			id: 't1',
			name: 'Task t1',
			archived: false,
			created: true,
			sessions: 3,
			messages: 10,
			tokens: null,
			costUsd: null,
		})
	})

	it('reads ledger sums the driver returns as text, and a real zero stays zero', () => {
		const [spent, free] = buildDayRows([
			item({ id: 't1', messages: 1, ledger_rows: '2', tokens: '1200', cost_usd: '0.12' }),
			item({ id: 't2', ledger_rows: 1, tokens: 0, cost_usd: null }),
		])
		expect(spent).toMatchObject({ id: 't1', tokens: 1200, costUsd: 0.12 })
		expect(free).toMatchObject({ id: 't2', tokens: 0, costUsd: 0 })
	})

	it('ranks by activity, highest first, then by cost', () => {
		const rows = buildDayRows([
			item({ id: 'quiet', messages: 1, ledger_rows: 1, tokens: 10, cost_usd: 5 }),
			item({ id: 'busy', created: true, sessions: 2, messages: 4 }),
			item({ id: 'pricey', messages: 2, ledger_rows: 1, tokens: 10, cost_usd: 1 }),
			item({ id: 'cheap', messages: 2, ledger_rows: 1, tokens: 10, cost_usd: 0.5 }),
			item({ id: 'untracked', messages: 2 }),
			// Only spent tokens that day: no activity, so it sits at the bottom.
			item({ id: 'spend-only', ledger_rows: 1, tokens: 99, cost_usd: 9 }),
		])
		expect(rows.map((row) => row.id)).toEqual(['busy', 'pricey', 'cheap', 'untracked', 'quiet', 'spend-only'])
	})

	it("counts a session row's own start once, and a task's creation on top of its sessions", () => {
		const rows = buildDayRows([
			item({ id: 'standalone', kind: 'session', created: true, sessions: 1, messages: 1 }),
			item({ id: 'task', kind: 'task', created: true, sessions: 1, messages: 0 }),
		])
		// The task row is 2 activities (created + 1 session); the session row is 2 (1 session + 1 message).
		// Equal, so the name breaks the tie.
		expect(rows.map((row) => row.id)).toEqual(['standalone', 'task'])
		expect(rows[0]).toMatchObject({ kind: 'session', created: true, sessions: 1, messages: 1 })
	})

	it('names untitled rows and carries the archived flag', () => {
		const rows = buildDayRows([
			item({ id: 's1', kind: 'session', name: null, archived: true, messages: 2 }),
			item({ id: 't1', name: '  ', archived: null, messages: 1 }),
		])
		expect(rows).toMatchObject([
			{ id: 's1', kind: 'session', name: 'Untitled session', archived: true },
			{ id: 't1', kind: 'task', name: 'Untitled task', archived: false },
		])
	})
})
