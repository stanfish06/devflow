import { expect, test } from '@playwright/test'

import { expectStackUp } from './helpers'
import { seedUsageFixture, USAGE_TODAY, type UsageFixture } from './usage-fixture'

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
