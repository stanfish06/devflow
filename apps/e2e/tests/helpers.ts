import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page } from '@playwright/test'

export const API_URL = process.env.DEVFLOW_API_URL ?? 'https://api.devflow.localhost:47443'
export const DEVFLOW_HOME = process.env.DEVFLOW_HOME ?? join(homedir(), '.devflow')
export const REPO_ROOT = join(import.meta.dirname, '../../..')

// The e2e project: a local repository whose `git@devflow.test:` remote resolves to a bare repo
// next to it (git `insteadOf`), so pushes work without GitHub.
const E2E_DIR = join(DEVFLOW_HOME, 'e2e')
export const E2E_REPO = join(E2E_DIR, 'devflow-e2e')
export const E2E_REMOTE = 'git@devflow.test:devflow-e2e.git'
export const E2E_PROJECT = 'devflow-e2e'

export const MODEL = process.env.DEVFLOW_E2E_MODEL ?? 'Haiku 5.5'

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function ensureE2eRepo(): void {
	if (existsSync(join(E2E_REPO, '.git'))) return
	mkdirSync(E2E_REPO, { recursive: true })
	git(E2E_REPO, 'init', '-q', '-b', 'main')
	writeFileSync(join(E2E_REPO, 'README.md'), '# devflow-e2e\n\nRepository used by devflow end-to-end tests.\n')
	git(E2E_REPO, 'add', '-A')
	git(
		E2E_REPO,
		'-c',
		'user.name=devflow e2e',
		'-c',
		'user.email=e2e@devflow.test',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-qm',
		'Initial commit',
	)
	git(E2E_DIR, 'clone', '-q', '--bare', E2E_REPO, 'devflow-e2e.git')
	git(E2E_REPO, 'config', `url.${E2E_DIR}/.insteadOf`, 'git@devflow.test:')
	git(E2E_REPO, 'remote', 'add', 'origin', E2E_REMOTE)
	git(E2E_REPO, 'fetch', '-q', 'origin')
	git(E2E_REPO, 'branch', '-q', '-u', 'origin/main', 'main')
}

export async function expectStackUp(): Promise<void> {
	const response = await fetch(`${API_URL}/health`).catch(() => null)
	if (!response?.ok) throw new Error(`devflow is not running at ${API_URL}. Start it with: bun run devflow up`)
}

/** Open the e2e project's new-task page, adding the project through the UI the first time. */
export async function openE2eProject(page: Page): Promise<void> {
	await page.goto('/')
	const project = page.getByRole('button', { name: new RegExp(`^${E2E_PROJECT} `) })
	if (!(await project.isVisible().catch(() => false))) {
		await page.goto('/settings/projects/new')
		const turnOn = page.getByRole('button', { name: 'Turn on' })
		if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
		// The Name field takes its default from the remote (`devflow-e2e`), so it is left empty.
		await page.getByPlaceholder('git@github.com:acme/app.git').fill(E2E_REMOTE)
		await page.getByPlaceholder('~/code/app').fill(E2E_REPO)
		await page.getByRole('button', { name: /^Add project/ }).click()
	} else {
		await project.click()
	}
	// The heading reads "What should we work on in <project>?" with the project name as a button.
	await expect(page.getByRole('main').getByRole('button', { name: E2E_PROJECT }).first()).toBeVisible({
		timeout: 30_000,
	})
	await expect(page).toHaveURL(/[?&]project=/)
}

type Size = 'Small' | 'Medium' | 'Large' | "Don't know yet"
type Permission = 'Ask first' | 'Auto-accept edits' | 'Auto' | 'Bypass permissions'

/** Pick size, model and permission mode in the composer, send the prompt, and wait for the task page. */
export async function startTask(
	page: Page,
	input: { prompt: string; size?: Size; model?: string; permission?: Permission },
): Promise<string> {
	await page.getByRole('button', { name: /^Task size:/ }).click()
	await page.getByRole('button', { name: new RegExp(`^${input.size ?? 'Small'}`) }).click()

	await chooseModel(page, input.model ?? MODEL)

	const permissionButton = page.locator('button', {
		hasText: /^(Auto|Ask first|Auto-accept edits|Bypass permissions)$/,
	})
	await permissionButton.click()
	// Menu items are named "<mode> <description>", e.g. "Auto Ask only for risky actions".
	await page.getByRole('button', { name: new RegExp(`^${input.permission ?? 'Auto'} `) }).click()

	await page.getByRole('textbox', { name: 'Message the agent' }).fill(input.prompt)
	await page.getByRole('button', { name: 'Start task' }).click()
	await page.waitForURL(/\/tasks\/[0-9a-f-]+/, { timeout: 60_000 })
	return page.url().match(/\/tasks\/([0-9a-f-]+)/)![1]!
}

export async function chooseModel(page: Page, model: string): Promise<void> {
	await page
		.locator('button', { hasText: /(Opus|Sonnet|Haiku|Fable|GPT)[- ]?\d/ })
		.last()
		.click()
	await page.getByRole('button', { name: model, exact: true }).click()
	await page.keyboard.press('Escape')
}

/** Send a follow-up in the open session. */
export async function sendFollowUp(page: Page, text: string): Promise<void> {
	await page.getByRole('textbox', { name: 'Message the agent' }).fill(text)
	await page.getByRole('button', { name: 'Send' }).click()
}

/** Wait until the open session's agent turn has ended (the stop button is gone). */
export async function waitForTurnEnd(page: Page, timeout = 240_000): Promise<void> {
	await expect(page.getByPlaceholder('Ask for follow-up changes')).toBeVisible({ timeout })
}

export async function archiveTask(page: Page, title: RegExp): Promise<void> {
	const archive = page.getByRole('button', { name: new RegExp(`^Archive ${title.source}`) }).first()
	if (await archive.isVisible().catch(() => false)) await archive.click()
}

/** Run the devflow CLI the way a user does (`bun run devflow ...`). */
export function devflowCli(...args: string[]): string {
	const result = spawnSync('bun', ['run', 'devflow', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
	if (result.status !== 0) throw new Error(`devflow ${args.join(' ')} failed:\n${result.stderr}`)
	return result.stdout
}

export function listeningPid(port: number): number | undefined {
	const out = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim()
	return out ? Number(out.split('\n')[0]) : undefined
}
