import { addDays, rangeLengthDays } from '@devflow/api-contract/api/metrics/range'
import type { UsageDayRow } from '@devflow/api-contract/api/usage/day'
import { periodWindows, yearWindow } from '@devflow/api-contract/api/usage/windows'
import type { DayUsage } from '@devflow/api-contract/api/usage/year'
import { describe, expect, it } from 'vitest'

import {
	cellLabel,
	cellSummary,
	chartCeiling,
	chartFamilies,
	chartSlots,
	chartTitle,
	costShare,
	FAMILY_ORDER,
	formatAxisCost,
	modelColor,
	modelFamily,
	modelName,
	slotAccessibleName,
	slotLabel,
	slotSummary,
	slotTitle,
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
	msUntilLocalMidnight,
	periodActivities,
	periodActivityDetail,
	periodDelta,
	periodTitle,
	readLocalClock,
	sameLocalClock,
	streaks,
	tokenBreakdown,
	topWeekdayLabel,
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

describe('local clock', () => {
	it('reads the local day and offset together', () => {
		const now = new Date(2026, 10, 24, 9, 30)
		expect(readLocalClock(now)).toEqual({ today: '2026-11-24', timezoneOffset: now.getTimezoneOffset() })
	})

	it('treats a re-read on the same day and offset as unchanged', () => {
		const morning = readLocalClock(new Date(2026, 10, 24, 9, 30))
		expect(sameLocalClock(morning, readLocalClock(new Date(2026, 10, 24, 23, 59)))).toBe(true)
		expect(sameLocalClock(morning, readLocalClock(new Date(2026, 10, 25, 0, 0)))).toBe(false)
		expect(sameLocalClock(morning, { ...morning, timezoneOffset: morning.timezoneOffset + 60 })).toBe(false)
	})

	it('counts down to the next local midnight, across a month and a year end', () => {
		expect(msUntilLocalMidnight(new Date(2026, 10, 24, 23, 59, 0))).toBe(60_000)
		expect(msUntilLocalMidnight(new Date(2026, 10, 30, 12, 0, 0))).toBe(
			new Date(2026, 11, 1).getTime() - new Date(2026, 10, 30, 12).getTime(),
		)
		expect(msUntilLocalMidnight(new Date(2026, 11, 31, 23, 0, 0))).toBe(
			new Date(2027, 0, 1).getTime() - new Date(2026, 11, 31, 23).getTime(),
		)
		// Exactly midnight is the start of a day: the next rollover is a whole day away.
		const start = new Date(2026, 10, 24)
		expect(msUntilLocalMidnight(start)).toBe(new Date(2026, 10, 25).getTime() - start.getTime())
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

describe('period section', () => {
	it('titles each period to date', () => {
		expect(periodTitle('week')).toBe('This week')
		expect(periodTitle('month')).toBe('This month')
		expect(periodTitle('year')).toBe('Last 12 months')
	})

	it('counts and breaks down activities as the grid does', () => {
		const totals = { tasks: 9, sessions: 41, messages: 136 }
		expect(periodActivities(totals)).toBe(186)
		expect(periodActivityDetail(totals)).toBe('9 tasks · 41 sessions · 136 messages')
		expect(periodActivityDetail({ tasks: 1, sessions: 1, messages: 0 })).toBe('1 task · 1 session · 0 messages')
	})

	it('breaks tokens down by kind', () => {
		expect(tokenBreakdown({ cacheRead: 600, cacheWrite: 100, input: 400, output: 100 })).toBe(
			'600 cache read · 100 cache write · 400 input · 100 output',
		)
	})

	it('compares with the previous period in whole percent', () => {
		expect(periodDelta(118, 100, 'month')).toBe('↑ 18% vs last month')
		expect(periodDelta(84.12, 75.79, 'month')).toBe('↑ 11% vs last month')
		expect(periodDelta(95, 100, 'week')).toBe('↓ 5% vs last week')
		expect(periodDelta(0, 2, 'year')).toBe('↓ 100% vs the 12 months before')
		expect(periodDelta(1200, 300, 'month')).toBe('↑ 300% vs last month')
		expect(periodDelta(12_000, 1_000, 'month')).toBe('↑ 1,100% vs last month')
		expect(periodDelta(100.2, 100, 'month')).toBe('About the same as last month')
	})

	it('hides the comparison when either side has no token data, or there was nothing before', () => {
		expect(periodDelta(null, 100, 'month')).toBeNull()
		expect(periodDelta(100, null, 'month')).toBeNull()
		expect(periodDelta(100, 0, 'month')).toBeNull()
	})

	it('names the most active weekday', () => {
		expect(topWeekdayLabel(1)).toBe('most active: Tue')
		expect(topWeekdayLabel(6)).toBe('most active: Sun')
		expect(topWeekdayLabel(null)).toBe('No active days yet')
	})
})

describe('model families', () => {
	it('reads the family from any form of model ID', () => {
		expect(modelFamily('claude-opus-4-8')).toBe('opus')
		expect(modelFamily('opus')).toBe('opus')
		expect(modelFamily('opus[1m]')).toBe('opus')
		expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet')
		expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
		expect(modelFamily('claude-fable-5-1')).toBe('fable')
		expect(modelFamily('claude-3-5-sonnet-20241022')).toBe('sonnet')
		expect(modelFamily('gpt-5.5')).toBe('other')
		expect(modelFamily('')).toBe('other')
	})

	it('colours every version of a family the same, from fixed chart slots', () => {
		expect(modelColor('claude-opus-4-8')).toBe('var(--chart-1)')
		expect(modelColor('claude-opus-4-5-20251101')).toBe(modelColor('opus'))
		expect(modelColor('claude-sonnet-4-6')).toBe('var(--chart-2)')
		expect(modelColor('claude-haiku-4-5')).toBe('var(--chart-11)')
		expect(modelColor('claude-fable-5')).toBe('var(--chart-9)')
		// Never a generated hue: anything unknown is the neutral ink.
		expect(modelColor('some-new-model')).toBe('var(--fg-3)')
		const slots = FAMILY_ORDER.map((family) => modelColor(family === 'other' ? 'x' : family))
		expect(new Set(slots).size).toBe(FAMILY_ORDER.length)
	})

	it('names a model the way people say it', () => {
		expect(modelName('claude-opus-4-8')).toBe('Opus 4.8')
		expect(modelName('claude-opus-4-5-20251101')).toBe('Opus 4.5')
		expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
		expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
		expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
		expect(modelName('claude-opus-4-6-1m')).toBe('Opus 4.6 1M')
		expect(modelName('opus[1m]')).toBe('Opus 1M')
		expect(modelName('sonnet')).toBe('Sonnet')
		expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
		expect(modelName('gpt-5.5')).toBe('gpt-5.5')
	})
})

describe('cost chart', () => {
	it('rounds the top up to a clean figure', () => {
		expect(chartCeiling(0)).toBe(0)
		expect(chartCeiling(0.12)).toBeCloseTo(0.15)
		expect(chartCeiling(0.3)).toBeCloseTo(0.3)
		expect(chartCeiling(0.1 + 0.2)).toBeCloseTo(0.3)
		expect(chartCeiling(7.31)).toBe(8)
		expect(chartCeiling(8.01)).toBe(10)
		expect(chartCeiling(123)).toBe(150)
		// Never below a cent.
		expect(chartCeiling(0.001)).toBeCloseTo(0.01)
	})

	it('labels the gridline in cents while small and whole dollars after', () => {
		expect(formatAxisCost(0.15)).toBe('$0.15')
		expect(formatAxisCost(2.5)).toBe('$2.50')
		expect(formatAxisCost(150)).toBe('$150')
		expect(formatAxisCost(1500)).toBe('$1,500')
	})

	it('has a bar for every slot, stacked by family in a fixed order, future slots empty', () => {
		const { slots: windowSlots } = periodWindows('week', '2026-11-25')
		const { slots, max } = chartSlots(
			[
				{
					start: '2026-11-23',
					costByModel: {
						'claude-haiku-4-5': 0.02,
						'claude-opus-4-8': 0.1,
						'claude-opus-4-5': 0.05,
						'gpt-5.5': 0.01,
					},
				},
				{ start: '2026-11-24', costByModel: { 'claude-sonnet-4-6': 0 } },
			],
			windowSlots,
			'2026-11-25',
		)
		expect(slots).toHaveLength(7)
		expect(slots.map((slot) => slot.future)).toEqual([false, false, false, true, true, true, true])
		const [monday, tuesday, wednesday] = slots
		// Opus at the bottom, whichever order the server listed the models in.
		expect(monday?.segments.map((segment) => segment.family)).toEqual(['opus', 'haiku', 'other'])
		expect(monday?.segments[0]?.costUsd).toBeCloseTo(0.15)
		expect(monday?.models.map((entry) => entry.model)).toEqual([
			'claude-opus-4-8',
			'claude-opus-4-5',
			'claude-haiku-4-5',
			'gpt-5.5',
		])
		expect(monday?.total).toBeCloseTo(0.18)
		// Rows that cost nothing are a real $0.00, not a missing one.
		expect(tuesday).toMatchObject({ empty: false, total: 0, segments: [] })
		expect(wednesday).toMatchObject({ empty: true, total: 0, segments: [], models: [] })
		expect(max).toBeCloseTo(0.2)
	})

	it('draws the slots before the server answers, empty', () => {
		const { slots, max } = chartSlots(undefined, periodWindows('month', '2026-02-10').slots, '2026-02-10')
		expect(slots).toHaveLength(28)
		expect(slots.every((slot) => slot.empty)).toBe(true)
		expect(max).toBe(0)
	})

	it('keeps a family on its colour whichever families a period has', () => {
		expect(chartFamilies([{ model: 'claude-haiku-4-5', costUsd: 9 }])).toEqual(['haiku'])
		expect(
			chartFamilies([
				{ model: 'gpt-5.5', costUsd: 3 },
				{ model: 'claude-fable-5-1', costUsd: 2 },
				{ model: 'claude-opus-4-8', costUsd: 1 },
				{ model: 'claude-opus-4-5', costUsd: 1 },
			]),
		).toEqual(['opus', 'fable', 'other'])
	})

	it('titles and labels bars by day, or by month for the year', () => {
		expect(chartTitle('week')).toBe('Daily cost by model')
		expect(chartTitle('month')).toBe('Daily cost by model')
		expect(chartTitle('year')).toBe('Monthly cost by model')
		expect(slotLabel('2026-11-01', 'month')).toBe('Nov 1')
		expect(slotLabel('2025-12-01', 'year')).toBe('Dec 2025')
		expect(slotTitle('2026-11-18', 'week')).toBe('Wed, Nov 18, 2026')
		expect(slotTitle('2026-11-01', 'year')).toBe('November 2026')
	})

	it('describes a bar, and never calls an unrecorded one free', () => {
		const { slots } = chartSlots(
			[
				{ start: '2026-11-18', costByModel: { 'claude-opus-4-5': 0.1, 'claude-haiku-4-5': 0.02 } },
				{ start: '2026-11-19', costByModel: {} },
			],
			['2026-11-18', '2026-11-19'],
			'2026-11-19',
		)
		const [spent, quiet] = slots
		if (!spent || !quiet) throw new Error('expected two slots')
		expect(slotSummary(spent)).toBe('$0.12')
		expect(slotAccessibleName(spent, 'month')).toBe('Wed, Nov 18, 2026: $0.12 · Opus 4.5 $0.10 · Haiku 4.5 $0.02')
		expect(slotSummary(quiet)).toBe('No cost recorded')
		expect(slotAccessibleName(quiet, 'month')).toBe('Thu, Nov 19, 2026: No cost recorded')
	})

	it("gives each model its share of the period's spend", () => {
		const byModel = [
			{ model: 'claude-opus-4-8', costUsd: 3 },
			{ model: 'claude-haiku-4-5', costUsd: 1 },
		]
		expect(costShare(3, byModel)).toBe(0.75)
		expect(costShare(0, [{ model: 'claude-opus-4-8', costUsd: 0 }])).toBe(0)
	})
})
