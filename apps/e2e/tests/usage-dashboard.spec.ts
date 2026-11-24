import { expect, test } from '@playwright/test'

import { expectStackUp } from './helpers'
import { seedUsageFixture, USAGE_DAY, USAGE_TODAY, type UsageFixture } from './usage-fixture'

// The grid buckets by the browser's calendar, so the clock and the time zone are both pinned.
test.use({ timezoneId: 'UTC' })

let fixture: UsageFixture | undefined

test.beforeAll(async () => {
	await expectStackUp()
	fixture = await seedUsageFixture()
})

test.afterAll(async () => {
	await fixture?.cleanup()
})

test('the sidebar opens Usage, and the year grid shows the seeded day', async ({ page }) => {
	await page.goto('/')
	const usageLink = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Usage' })
	await expect(usageLink).toBeVisible({ timeout: 30_000 })
	// Pin the clock only once the app is signed in: the auth provider schedules token renewal from
	// `expiresAt - Date.now()`, which a 2020 clock would turn into an immediate, endless refresh. The
	// sidebar link is a client-side navigation, so the page reads its "today" from the pinned clock.
	await page.clock.setFixedTime(new Date(`${USAGE_TODAY}T12:00:00Z`))
	await usageLink.click()
	await expect(page).toHaveURL(/\/usage$/)
	await expect(usageLink).toHaveClass(/\bsel\b/)

	const grid = page.getByRole('region', { name: 'Activity in the last year' })
	// The Claude day's three, and the Codex day's session.
	await expect(grid.getByText('4 activities', { exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(grid.getByText(/since Jun 10/)).toBeVisible()
	// 52 whole weeks and Monday to Wednesday of this one.
	await expect(grid.locator('.usage-cell')).toHaveCount(52 * 7 + 3)

	const day = grid.getByRole('button', { name: '3 activities: 1 task, 1 session, 1 message · Wed, Jun 10, 2020' })
	await expect(day).toHaveClass(/usage-cell l[1-4]/)
	await day.hover()
	await expect(page.getByRole('tooltip')).toHaveText('3 activities: 1 task, 1 session, 1 message · Wed, Jun 10, 2020')

	const quiet = grid.getByRole('button', { name: 'No activity · Thu, Jun 11, 2020' })
	await expect(quiet).toHaveClass(/usage-cell l0/)
})

test('the standard layout sends /usage home', async ({ page }) => {
	await page.goto('/usage?minimal_ui=false')
	await expect(page).not.toHaveURL(/\/usage/)
})

test('the Tokens and Cost lenses repaint the grid from the usage ledger', async ({ page }) => {
	await page.goto('/')
	const usageLink = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Usage' })
	await expect(usageLink).toBeVisible({ timeout: 30_000 })
	await page.clock.setFixedTime(new Date(`${USAGE_TODAY}T12:00:00Z`))
	await usageLink.click()

	const grid = page.getByRole('region', { name: 'Activity in the last year' })
	const lenses = grid.getByRole('radiogroup', { name: 'Grid shows' })
	await expect(lenses.getByRole('radio', { name: 'Activity' })).toBeChecked({ timeout: 30_000 })

	await lenses.getByRole('radio', { name: 'Tokens' }).click()
	await expect(lenses.getByRole('radio', { name: 'Tokens' })).toBeChecked()
	// Every token kind, cache reads included, as the session badge counts them.
	await expect(grid.getByText('1,200 tokens', { exact: true })).toBeVisible()
	await expect(grid.locator('.usage-cell')).toHaveCount(52 * 7 + 3)
	const tokenDay = grid.getByRole('button', {
		name: '1,200 tokens: 600 cache read · 100 cache write · 400 input · 100 output · Wed, Jun 10, 2020',
	})
	await expect(tokenDay).toHaveClass(/usage-cell l[1-4]/)
	await tokenDay.hover()
	await expect(page.getByRole('tooltip')).toHaveText(
		'1,200 tokens: 600 cache read · 100 cache write · 400 input · 100 output · Wed, Jun 10, 2020',
	)
	// Codex records no usage: the day had activity, so it says so rather than reading as free.
	const codexDay = grid.getByRole('button', { name: 'No token data recorded · Fri, Jun 12, 2020' })
	await expect(codexDay).toHaveClass(/usage-cell l0/)

	await lenses.getByRole('radio', { name: 'Cost' }).click()
	await expect(grid.getByText('$0.12 spent', { exact: true })).toBeVisible()
	const costDay = grid.getByRole('button', { name: '$0.12 spent · Wed, Jun 10, 2020' })
	await expect(costDay).toHaveClass(/usage-cell l[1-4]/)
	await expect(grid.getByRole('button', { name: 'No token data recorded · Fri, Jun 12, 2020' })).toBeVisible()

	await lenses.getByRole('radio', { name: 'Activity' }).click()
	await expect(grid.getByText('4 activities', { exact: true })).toBeVisible()
})

test('clicking a day lists what you worked on, and clicking it again closes the list', async ({ page }) => {
	await page.goto('/')
	const usageLink = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Usage' })
	await expect(usageLink).toBeVisible({ timeout: 30_000 })
	await page.clock.setFixedTime(new Date(`${USAGE_TODAY}T12:00:00Z`))
	await usageLink.click()

	const grid = page.getByRole('region', { name: 'Activity in the last year' })
	const day = grid.getByRole('button', { name: '3 activities: 1 task, 1 session, 1 message · Wed, Jun 10, 2020' })
	await day.click({ timeout: 30_000 })
	await expect(page).toHaveURL(new RegExp(`/usage\\?day=${USAGE_DAY}$`))
	await expect(day).toHaveClass(/\bsel\b/)
	await expect(day).toHaveAttribute('aria-pressed', 'true')

	const list = page.getByRole('region', { name: 'Work on Wed, Jun 10, 2020' })
	await expect(list.getByRole('heading')).toHaveText('Wed, Jun 10, 2020 · 1 task')
	const row = list.getByRole('row').filter({ hasText: fixture?.taskName ?? 'missing fixture' })
	await expect(row).toBeVisible()
	// Archived work keeps its history and its tag; the tokens and cost match the session badge.
	await expect(row.getByText('Archived', { exact: true })).toBeVisible()
	await expect(row.getByText('Created · 1 session · 1 message', { exact: true })).toBeVisible()
	await expect(row.getByRole('cell')).toHaveText([/Usage e2e fixture/, '3', '1,200', '$0.12'])
	await expect(row.getByRole('link', { name: fixture?.taskName })).toHaveAttribute('href', /\/tasks\//)

	// Clicking the selected cell again closes the list.
	await day.click()
	await expect(page).toHaveURL(/\/usage$/)
	await expect(list).toBeHidden()

	// A Codex session with no task gets its own row, and its usage reads as unrecorded, not free.
	await grid.getByRole('button', { name: '1 activity: 0 tasks, 1 session, 0 messages · Fri, Jun 12, 2020' }).click()
	const codexList = page.getByRole('region', { name: 'Work on Fri, Jun 12, 2020' })
	await expect(codexList.getByRole('heading')).toHaveText('Fri, Jun 12, 2020 · 1 session')
	const codexRow = codexList.getByRole('row').filter({ hasText: 'Usage e2e Codex fixture' })
	await expect(codexRow.getByText('Started', { exact: true })).toBeVisible()
	await expect(codexRow.getByRole('cell')).toHaveText([
		/Usage e2e Codex fixture/,
		'1',
		/No token data recorded/,
		/No token data recorded/,
	])
	await expect(codexRow.getByRole('link')).toHaveAttribute('href', /\/sessions\//)

	// Clear closes it too; a quiet day says so.
	await codexList.getByRole('button', { name: 'Clear' }).click()
	await expect(codexList).toBeHidden()
	await grid.getByRole('button', { name: 'No activity · Thu, Jun 11, 2020' }).click()
	await expect(page.getByRole('region', { name: 'Work on Thu, Jun 11, 2020' })).toContainText(
		'No activity on this day.',
	)

	// Browsing days replaced the history entry, so Back leaves the page.
	await page.goBack()
	await expect(page).not.toHaveURL(/\/usage/)
})

test('a link to a day reopens its list, and survives a reload', async ({ page }) => {
	// No pinned clock: the list reads its day from the URL, whatever today is.
	await page.goto(`/usage?day=${USAGE_DAY}`)
	const list = page.getByRole('region', { name: 'Work on Wed, Jun 10, 2020' })
	const row = list.getByRole('row').filter({ hasText: fixture?.taskName ?? 'missing fixture' })
	await expect(row.getByRole('cell').last()).toHaveText('$0.12', { timeout: 30_000 })

	await page.reload()
	await expect(page).toHaveURL(new RegExp(`/usage\\?day=${USAGE_DAY}$`))
	await expect(row.getByRole('cell').last()).toHaveText('$0.12', { timeout: 30_000 })
})

test('the period switch summarises the week, month and year, and Back undoes a switch', async ({ page }) => {
	await page.goto('/')
	const usageLink = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Usage' })
	await expect(usageLink).toBeVisible({ timeout: 30_000 })
	await page.clock.setFixedTime(new Date(`${USAGE_TODAY}T12:00:00Z`))
	await usageLink.click()

	// Month is the default: Jun 1–17, which holds both fixture days.
	const month = page.getByRole('region', { name: 'This month' })
	const periods = month.getByRole('radiogroup', { name: 'Period' })
	await expect(periods.getByRole('radio', { name: 'Month' })).toBeChecked({ timeout: 30_000 })
	const tile = (section: typeof month, label: string) => section.getByRole('group', { name: label })
	await expect(tile(month, 'Activities').locator('.v')).toHaveText('4', { timeout: 30_000 })
	await expect(tile(month, 'Activities').locator('.d')).toHaveText('1 task · 2 sessions · 1 message')
	await expect(tile(month, 'Tokens').locator('.v')).toHaveText('1,200')
	// May recorded nothing, so there is no comparison to make, only the breakdown.
	await expect(tile(month, 'Tokens').locator('.d')).toHaveText([
		'600 cache read · 100 cache write · 400 input · 100 output',
	])
	await expect(tile(month, 'Cost').locator('.v')).toHaveText('$0.12')
	await expect(tile(month, 'Cost').locator('.d')).toHaveCount(0)
	await expect(tile(month, 'Active days').locator('.v')).toHaveText('2 / 17')
	await expect(tile(month, 'Active days').locator('.d')).toHaveText('most active: Wed')
	await expect(
		page.getByText('Tokens and cost cover Claude sessions only. Codex sessions count toward activity.'),
	).toBeVisible()

	// This week, Monday Jun 15 to today, is empty: zeros for activity, no data rather than $0.00 for usage.
	await periods.getByRole('radio', { name: 'Week' }).click()
	await expect(page).toHaveURL(/\/usage\?period=week$/)
	const week = page.getByRole('region', { name: 'This week' })
	await expect(week.getByRole('radio', { name: 'Week' })).toBeChecked()
	await expect(tile(week, 'Activities').locator('.v')).toHaveText('0', { timeout: 30_000 })
	await expect(tile(week, 'Tokens').locator('.v')).toHaveText('—')
	await expect(tile(week, 'Tokens').locator('.d')).toHaveText('No token data recorded')
	await expect(tile(week, 'Cost').locator('.d')).toHaveText('No token data recorded')
	await expect(tile(week, 'Active days').locator('.v')).toHaveText('0 / 3')

	// The last twelve months, Jul 1, 2019 to today.
	await week.getByRole('radio', { name: 'Year' }).click()
	await expect(page).toHaveURL(/\/usage\?period=year$/)
	const year = page.getByRole('region', { name: 'Last 12 months' })
	await expect(tile(year, 'Activities').locator('.v')).toHaveText('4', { timeout: 30_000 })
	await expect(tile(year, 'Cost').locator('.v')).toHaveText('$0.12')
	await expect(tile(year, 'Active days').locator('.v')).toHaveText('2 / 353')

	// Each switch was its own step: Back walks them back to the default month.
	await page.goBack()
	await expect(page).toHaveURL(/\/usage\?period=week$/)
	await expect(page.getByRole('region', { name: 'This week' })).toBeVisible()
	await page.goBack()
	await expect(page).toHaveURL(/\/usage$/)
	await expect(tile(month, 'Activities').locator('.v')).toHaveText('4')
})

test('the cost chart, by-model list and top tasks show where the money went', async ({ page }) => {
	await page.goto('/')
	const usageLink = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Usage' })
	await expect(usageLink).toBeVisible({ timeout: 30_000 })
	await page.clock.setFixedTime(new Date(`${USAGE_TODAY}T12:00:00Z`))
	await usageLink.click()

	// June: a bar for every day of the month, the 18th–30th still to come.
	const chart = page.getByRole('region', { name: 'Daily cost by model' })
	const bars = chart.getByRole('group', { name: 'Daily cost by model, 30 bars' })
	await expect(bars).toBeVisible({ timeout: 30_000 })
	await expect(chart.locator('.usage-bar')).toHaveCount(30)
	await expect(chart.locator('.usage-bar.future')).toHaveCount(13)
	// The Opus family names the legend; the tooltip names the model.
	await expect(chart.locator('.usage-legend')).toHaveText('Opus')

	const spentBar = bars.getByRole('img', { name: 'Wed, Jun 10, 2020: $0.12 · Opus 4.5 $0.12' })
	await spentBar.hover()
	const tooltip = page.getByRole('tooltip')
	await expect(tooltip).toContainText('$0.12 · Wed, Jun 10, 2020')
	await expect(tooltip.locator('.row')).toHaveText(['$0.12 Opus 4.5'])
	// The Codex day spent nothing it could record.
	await bars.getByRole('img', { name: 'Fri, Jun 12, 2020: No cost recorded' }).hover()
	await expect(tooltip).toHaveText('No cost recorded · Fri, Jun 12, 2020')

	const byModel = page.getByRole('region', { name: 'By model' })
	await expect(byModel.getByRole('listitem')).toHaveText([/Opus 4\.5\s*\$0\.12/])

	// The archived fixture task still ranks, says it is archived, and links through to its page.
	const topTasks = page.getByRole('region', { name: 'Top tasks' })
	const taskRow = topTasks.getByRole('row').filter({ hasText: fixture?.taskName ?? 'missing fixture' })
	await expect(taskRow.getByRole('cell')).toHaveText([/Usage e2e fixture.*Archived/, '1,200', '$0.12'])

	// This week recorded nothing: seven bars, none drawn, and the lists say so rather than showing $0.00.
	await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: 'Week' }).click()
	const week = page.getByRole('region', { name: 'This week' })
	const weekChart = week.getByRole('region', { name: 'Daily cost by model' })
	await expect(weekChart.locator('.usage-bar')).toHaveCount(7, { timeout: 30_000 })
	await expect(weekChart.getByText('No cost recorded this period.')).toBeVisible()
	await expect(week.getByRole('region', { name: 'By model' })).toContainText('No cost recorded this period.')
	await expect(week.getByRole('region', { name: 'Top tasks' })).toContainText('No task spend recorded this period.')

	await page.goBack()
	await taskRow.getByRole('link', { name: fixture?.taskName }).click({ timeout: 30_000 })
	await expect(page).toHaveURL(/\/tasks\//)
})

test('a link to a period and a day opens both, independently', async ({ page }) => {
	await page.goto(`/usage?period=week&day=${USAGE_DAY}`)
	const list = page.getByRole('region', { name: 'Work on Wed, Jun 10, 2020' })
	const row = list.getByRole('row').filter({ hasText: fixture?.taskName ?? 'missing fixture' })
	await expect(row.getByRole('cell').last()).toHaveText('$0.12', { timeout: 30_000 })
	const week = page.getByRole('region', { name: 'This week' })
	await expect(week.getByRole('radio', { name: 'Week' })).toBeChecked({ timeout: 30_000 })

	// Closing the day keeps the period.
	await list.getByRole('button', { name: 'Clear' }).click()
	await expect(page).toHaveURL(/\/usage\?period=week$/)
	await expect(week).toBeVisible()
})
