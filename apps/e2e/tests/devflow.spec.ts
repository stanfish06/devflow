import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import {
	API_PORT,
	archiveTask,
	devflowCli,
	ensureE2eRepo,
	expectStackUp,
	listeningPid,
	openE2eProject,
	sendFollowUp,
	startTask,
	waitForTurnEnd,
} from './helpers'

const WORKSPACES = join(homedir(), '.devflow', 'workspaces')

/** Read a file the agent wrote in the newest worktree whose name starts with the task slug. */
function worktreeFile(slugStart: string, file: string): string | undefined {
	const dir = readdirSync(WORKSPACES)
		.filter((name) => name.startsWith(slugStart))
		.sort((a, b) => statSync(join(WORKSPACES, b)).mtimeMs - statSync(join(WORKSPACES, a)).mtimeMs)[0]
	const path = dir ? join(WORKSPACES, dir, file) : undefined
	return path && existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

test.beforeAll(async () => {
	await expectStackUp()
	ensureE2eRepo()
})

test('app opens signed in as the local user, with the minimalist UI and an online host', async ({ page }) => {
	await page.goto('/')
	await expect(page.getByRole('group', { name: 'devflow' })).toBeVisible()
	await expect(page.getByTestId('minimalist-interface')).toBeVisible()
	await expect(page.getByText('This is the beta of the new minimalist UI')).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeVisible()
	await expect(page).toHaveTitle('devflow')
})

test('task runs in the Docker sandbox and a follow-up resumes the same conversation', async ({ page }) => {
	await openE2eProject(page)
	const taskId = await startTask(page, {
		prompt: 'Write the word kiwi to fruit-e2e.txt, then run `uname -s` and reply with only its output.',
	})
	await waitForTurnEnd(page)
	// The sandbox is a Linux container even on macOS.
	await expect(page.getByText('Linux', { exact: true }).first()).toBeVisible()
	await expect.poll(() => worktreeFile('write-the-word-kiwi', 'fruit-e2e.txt')?.trim()).toBe('kiwi')

	await sendFollowUp(
		page,
		'Without reading any file, which word did you write, and to which file? Reply in one line.',
	)
	await waitForTurnEnd(page)
	await expect(page.getByText(/kiwi/i).filter({ visible: true }).last()).toBeVisible()
	await expect(
		page
			.getByText(/fruit-e2e\.txt/)
			.filter({ visible: true })
			.last(),
	).toBeVisible()

	await page.reload()
	// Everything above is stored in Postgres: a reload shows both turns.
	await expect(page.getByText(/kiwi/i).first()).toBeVisible()
	await archiveTask(page, taskId)
})

test('a command in Ask first mode waits for approval, then runs', async ({ page }) => {
	await openE2eProject(page)
	await startTask(page, {
		prompt: 'Run the shell command `echo approved-e2e > approval-e2e.txt` exactly once, then reply done.',
		permission: 'Ask first',
	})
	await expect(page.getByText('Run this command?')).toBeVisible()
	await expect(page.getByText('echo approved-e2e > approval-e2e.txt').first()).toBeVisible()
	await page.getByRole('button', { name: /^Approve/ }).click()
	await waitForTurnEnd(page)
	await expect
		.poll(() => worktreeFile('run-the-shell-command-echo-approved-e2e', 'approval-e2e.txt')?.trim())
		.toBe('approved-e2e')
})

test('the API crashing mid-turn loses no events', async ({ page }) => {
	await openE2eProject(page)
	await startTask(page, {
		prompt: 'Run `sleep 20 && echo first-half` in the shell, then run `echo second-half`, then reply with both outputs on one line.',
	})
	await expect(page.getByText(/sleep 20/).first()).toBeVisible()
	// Kill the API (devflow restarts it within seconds); the daemon retries its event writes.
	const api = listeningPid(API_PORT)
	expect(api).toBeDefined()
	process.kill(api!, 'SIGKILL')
	await waitForTurnEnd(page, 300_000)
	await page.reload()
	await expect(page.getByText(/first-half.*second-half/).first()).toBeVisible()
	expect(listeningPid(API_PORT)).not.toBe(api)
})

test('Medium (RPI) task auto-advances from research questions to research', async ({ page }) => {
	await openE2eProject(page)
	const taskId = await startTask(page, {
		prompt: 'Add a one-line CONTRIBUTING.md that says pull requests are welcome.',
		size: 'Medium',
	})
	await expect(page.getByText(/^research-questions:/).first()).toBeVisible({ timeout: 240_000 })
	// The second session is created by the API's auto-advance, not by the test.
	await expect(page.getByText(/^research:/).first()).toBeVisible({ timeout: 360_000 })
	await expect(page.getByText(/01-research-questions/).first()).toBeVisible()

	// The board tags the task with its stage group, from the labels the agent's sessions wrote.
	// Questions, research and design all fall under Research & Design, so a further auto-advance holds.
	await page.goto('/board')
	await expect(page.locator(`[data-task-id="${taskId}"] [data-stage="research-design"]`)).toHaveText(
		'Research & Design',
	)
})

test('the CLI lists the tasks created in the UI', async () => {
	const out = devflowCli('api', 'sync', 'tasks', '--limit', '500')
	const rows = (JSON.parse(out.slice(out.indexOf('{'))) as { rows: Array<{ name: string }> }).rows
	expect(rows.some((row) => /kiwi/i.test(row.name) || /fruit/i.test(row.name))).toBe(true)
})

test('Codex runs through codex app-server', async ({ page }) => {
	test.skip(!existsSync(join(homedir(), '.codex', 'auth.json')), 'No Codex CLI login (codex login)')
	await openE2eProject(page)
	await startTask(page, {
		prompt: 'Create codex-e2e.txt containing the word papaya, run `cat codex-e2e.txt`, and reply with the output.',
		// The Codex CLI names its models (`model/list`); take the first one unless one is set.
		model: process.env.DEVFLOW_E2E_CODEX_MODEL ?? /^GPT/,
		permission: 'Bypass permissions',
	})
	await waitForTurnEnd(page)
	await expect(
		page
			.getByText(/papaya/)
			.filter({ visible: true })
			.last(),
	).toBeVisible()
	await expect.poll(() => worktreeFile('create-codex-e2e-txt', 'codex-e2e.txt')?.trim()).toBe('papaya')
})

// A host started with `bun run devflow remote <ssh-host>`, by the name it shows in the host menu.
const REMOTE_HOST = process.env.DEVFLOW_E2E_REMOTE_HOST

test('a task runs on a remote host', async ({ page }) => {
	test.skip(!REMOTE_HOST, 'Set DEVFLOW_E2E_REMOTE_HOST to a host started with bun run devflow remote')
	const host = REMOTE_HOST ?? ''
	await page.goto('/')
	await page.getByRole('button', { name: /^Host: / }).click()
	await page.getByRole('button', { name: new RegExp(`^${host} Online`) }).click()
	await expect(page.getByRole('button', { name: `Host: ${host}` })).toBeVisible()
	// A directory task needs no clone: the agent works in /tmp on that host.
	await page.getByRole('button', { name: /^Project: / }).click()
	await page.getByRole('textbox', { name: 'Directory path' }).fill('/tmp')
	await page.getByRole('button', { name: 'Use directory' }).click()
	await startTask(page, {
		prompt: 'Write the word mango to remote-e2e.txt, run `cat remote-e2e.txt`, and reply with only its output.',
		permission: 'Bypass permissions',
	})
	// The reply is the file's content alone; the prompt also says "mango", so match the whole text.
	await expect(page.getByText('mango', { exact: true }).filter({ visible: true }).last()).toBeVisible({
		timeout: 240_000,
	})
	await waitForTurnEnd(page)
	await expect(page.getByText(host, { exact: true }).filter({ visible: true }).first()).toBeVisible()
})

test('the board moves a task to another status by drag, and the list groups it there', async ({ page }) => {
	await page.goto('/board')
	const card = page.locator('[data-task-id]').first()
	await expect(card).toBeVisible({ timeout: 30_000 })
	const taskId = (await card.getAttribute('data-task-id')) ?? ''
	const name = (await card.locator('.line-clamp-2').textContent()) ?? ''
	const from = (await card.locator('xpath=ancestor::section[1]').getAttribute('aria-label')) ?? ''
	const to = from === 'Done' ? 'Todo' : 'Done'
	const column = (label: string) => page.getByRole('region', { name: label, exact: true })

	await card.dragTo(column(to))
	await expect(column(to).locator(`[data-task-id="${taskId}"]`)).toBeVisible()
	// The status is stored: it survives a reload and shows in the list layout's group.
	await page.goto('/board?layout=list')
	await expect(
		column(to)
			.getByRole('button', { name: new RegExp(escapeRegExp(name)) })
			.first(),
	).toBeVisible()

	// Back with the status menu, the keyboard path besides dragging.
	await page.goto('/board')
	await column(to)
		.locator(`[data-task-id="${taskId}"]`)
		.getByRole('button', { name: /^Status of / })
		.click()
	await page.getByRole('menuitem', { name: new RegExp(`(^| )${from}$`) }).click()
	await expect(column(from).locator(`[data-task-id="${taskId}"]`)).toBeVisible()
})

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
