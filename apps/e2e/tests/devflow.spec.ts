import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import {
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
	await startTask(page, {
		prompt: 'Write the word kiwi to fruit-e2e.txt, then run `uname -s` and reply with only its output.',
	})
	await waitForTurnEnd(page)
	// The sandbox is a Linux container even on macOS.
	await expect(page.getByText('Linux', { exact: true }).first()).toBeVisible()
	expect(worktreeFile('write-the-word-kiwi', 'fruit-e2e.txt')?.trim()).toBe('kiwi')

	await sendFollowUp(
		page,
		'Without reading any file, which word did you write, and to which file? Reply in one line.',
	)
	await waitForTurnEnd(page)
	await expect(page.getByText(/kiwi/i).last()).toBeVisible()
	await expect(page.getByText(/fruit-e2e\.txt/).last()).toBeVisible()

	await page.reload()
	// Everything above is stored in Postgres: a reload shows both turns.
	await expect(page.getByText(/kiwi/i).first()).toBeVisible()
	await archiveTask(page, /Write .*kiwi|Kiwi/i)
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
	expect(worktreeFile('run-the-shell-command-echo-approved-e2e', 'approval-e2e.txt')?.trim()).toBe('approved-e2e')
})

test('the API crashing mid-turn loses no events', async ({ page }) => {
	await openE2eProject(page)
	await startTask(page, {
		prompt: 'Run `sleep 20 && echo first-half` in the shell, then run `echo second-half`, then reply with both outputs on one line.',
	})
	await expect(page.getByText(/sleep 20/).first()).toBeVisible()
	// Kill the API (devflow restarts it within seconds); the daemon retries its event writes.
	const api = listeningPid(47100)
	expect(api).toBeDefined()
	process.kill(api!, 'SIGKILL')
	await waitForTurnEnd(page, 300_000)
	await page.reload()
	await expect(page.getByText(/first-half.*second-half/).first()).toBeVisible()
	expect(listeningPid(47100)).not.toBe(api)
})

test('Medium (RPI) task auto-advances from research questions to research', async ({ page }) => {
	await openE2eProject(page)
	await startTask(page, {
		prompt: 'Add a one-line CONTRIBUTING.md that says pull requests are welcome.',
		size: 'Medium',
	})
	await expect(page.getByText(/^research-questions:/).first()).toBeVisible({ timeout: 240_000 })
	// The second session is created by the API's auto-advance, not by the test.
	await expect(page.getByText(/^research:/).first()).toBeVisible({ timeout: 360_000 })
	await expect(page.getByText(/01-research-questions/).first()).toBeVisible()
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
		model: 'GPT-6 Astra',
		permission: 'Bypass permissions',
	})
	await waitForTurnEnd(page)
	await expect(page.getByText(/papaya/).last()).toBeVisible()
	expect(worktreeFile('create-codex-e2e-txt', 'codex-e2e.txt')?.trim()).toBe('papaya')
})
