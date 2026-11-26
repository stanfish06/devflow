import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'

import { connectToStack } from './stack-database'

const taskId = randomUUID()
const prdId = randomUUID()
const tddId = randomUUID()

// No daemon or model is needed. Each session waits for a user, and only the fixture IDs are removed.
test.beforeAll(async () => {
	const { client, config } = await connectToStack()
	try {
		const start = Date.now()
		await client.query('BEGIN')
		await client.query(
			`INSERT INTO tasks (id, organization_id, created_by, resource_owner_user_id, name, workflow_type)
			 VALUES ($1, $2, $3, $3, 'Session graph fixture', 'prd_tdd')`,
			[taskId, config.organizationId, config.userId],
		)
		for (const [id, label, title] of [
			[prdId, 'rpi:design-prd', 'PRD'],
			[tddId, 'rpi:design-tdd', 'TDD'],
		] as const) {
			await client.query(
				`INSERT INTO sessions (id, organization_id, task_id, created_by, resource_owner_user_id,
				 host_id, working_directory, coding_agent, status, title, labels, created_at, updated_at, last_activity_at)
				 VALUES ($1, $2, $3, $4, $4, 'graph-fixture', '/tmp', 'codex', 'ready_for_input', $5, $6, $7, $7, $7)`,
				[
					id,
					config.organizationId,
					taskId,
					config.userId,
					title,
					JSON.stringify([{ name: label, title }]),
					start + (id === tddId ? 1 : 0),
				],
			)
			await client.query(
				`INSERT INTO conversation_events (id, organization_id, session_id, task_id, resource_owner_user_id,
				 user_id, event_type, role, content) VALUES ($1, $2, $3, $4, $5, $5, 'message', 'user', $6)`,
				[randomUUID(), config.organizationId, id, taskId, config.userId, `Notes for the ${title} conversation`],
			)
		}
		await client.query('COMMIT')
	} finally {
		await client.end()
	}
})

test.afterAll(async () => {
	const { client } = await connectToStack()
	try {
		await client.query('DELETE FROM conversation_events WHERE task_id = $1', [taskId])
		await client.query('DELETE FROM sessions WHERE task_id = $1', [taskId])
		await client.query('DELETE FROM tasks WHERE id = $1', [taskId])
	} finally {
		await client.end()
	}
})

for (const minimal of [true, false]) {
	test(`the ${minimal ? 'minimal' : 'standard'} task session shows its current stage while browsing history`, async ({
		page,
	}) => {
		await page.goto(`/sessions/${tddId}?minimal_ui=${minimal}`)
		const current = page.locator(`.react-flow__node[data-id="${tddId}"]`)
		const previous = page.locator(`.react-flow__node[data-id="${prdId}"]`)
		await expect(page.getByText('Notes for the TDD conversation', { exact: true }).first()).toBeVisible()
		await expect(current).toBeInViewport()
		await expect(current).toContainText('TDD')
		await previous.click()
		await expect(page).toHaveURL(
			minimal ? new RegExp(`/tasks/${taskId}.*session=${prdId}`) : new RegExp(`/sessions/${prdId}`),
		)
		await expect(page.getByText('Notes for the PRD conversation', { exact: true }).first()).toBeVisible()
		await expect(previous).toBeInViewport()
		await expect(current.locator('[aria-current="step"]')).toContainText('TDD')
		// Move the sibling session to another stage while this historical conversation stays open.
		const { client } = await connectToStack()
		try {
			await client.query('UPDATE sessions SET labels = $2 WHERE id = $1', [
				tddId,
				JSON.stringify([{ name: 'rpi:implementation', title: 'implement' }]),
			])
			await expect(page.getByText('Current stage implement', { exact: true })).toBeVisible()
			await expect(current.locator('[aria-current="step"]')).toContainText('implement')
			await expect(page.getByText('Notes for the PRD conversation', { exact: true }).first()).toBeVisible()
		} finally {
			try {
				await client.query('UPDATE sessions SET labels = $2 WHERE id = $1', [
					tddId,
					JSON.stringify([{ name: 'rpi:design-tdd', title: 'TDD' }]),
				])
			} finally {
				await client.end()
			}
		}
		await expect(page.getByText('Current stage TDD', { exact: true })).toBeVisible()
		await current.getByRole('button', { name: 'Open TDD session' }).press('Enter')
		await expect(page).toHaveURL(
			minimal ? new RegExp(`/tasks/${taskId}.*session=${tddId}`) : new RegExp(`/sessions/${tddId}`),
		)
		if (minimal) {
			const firstPhase = page.locator('.react-flow__node[data-id="placeholder-questions"]')
			const lastPhase = page.locator('.react-flow__node[data-id="placeholder-PR"]')
			await expect(lastPhase).not.toBeInViewport()
			await page.getByRole('button', { name: 'Fit workflow graph' }).click()
			await expect(firstPhase).toBeInViewport()
			await expect(lastPhase).toBeInViewport()
			await page.setViewportSize({ width: 1280, height: 720 })
			await expect(firstPhase).toBeInViewport()
			await expect(lastPhase).toBeInViewport()
		}
	})
}

test('the minimal task drawer opens a workflow session on a narrow screen', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(`/tasks/${taskId}?minimal_ui=true`)
	await page.getByRole('button', { name: 'Open task navigation' }).click()
	const nav = page.getByRole('complementary', { name: 'Task navigation' })
	await expect(nav.locator('[aria-current="step"]')).toContainText('TDD')
	await nav.locator(`.react-flow__node[data-id="${prdId}"]`).click()
	await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}.*session=${prdId}`))
	await expect(page.getByRole('button', { name: 'Open task navigation' })).toHaveAttribute('aria-expanded', 'false')
	await expect(page.getByText('Notes for the PRD conversation', { exact: true }).first()).toBeInViewport()
})
