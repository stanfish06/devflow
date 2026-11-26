import { spawnSync } from 'node:child_process'

import { type Page, expect, test } from '@playwright/test'

import {
	archiveTask,
	E2E_PROJECT,
	ensureE2eRepo,
	expectStackUp,
	openE2eProject,
	startTask,
	waitForTurnEnd,
} from './helpers'

const limactlList = () => spawnSync('limactl', ['list', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout ?? ''
const taskVmName = (taskId: string) => `devflow-task-${taskId.replace(/-/g, '').slice(-12)}`

/** Settings → Projects → the e2e project → Agent sandbox. */
async function setProjectSandbox(page: Page, label: string): Promise<void> {
	await page.goto('/settings/projects')
	const select = page.getByRole('combobox', { name: `Agent sandbox for ${E2E_PROJECT}` })
	if (!(await select.isVisible().catch(() => false)))
		await page
			.getByRole('button', { name: new RegExp(`^${E2E_PROJECT}`) })
			.first()
			.click()
	await select.click()
	await page.getByRole('option', { name: label }).click()
	await expect(select).toHaveText(label)
}

test.describe('VM sandbox', () => {
	test.skip(
		process.env.DEVFLOW_E2E_VM !== '1',
		'Creates Lima VMs (minutes, several GB of disk): set DEVFLOW_E2E_VM=1',
	)
	test.skip(spawnSync('limactl', ['--version']).status !== 0, 'limactl is not on PATH (run inside nix develop)')
	// The first VM provisions the base image.
	test.describe.configure({ timeout: 45 * 60_000 })

	test.beforeAll(async () => {
		await expectStackUp()
		ensureE2eRepo()
	})

	test.afterAll(async ({ browser }) => {
		const page = await browser.newPage()
		await setProjectSandbox(page, 'Host default')
		await page.close()
	})

	test('own VM uses the CPU and memory requested in the composer', async ({ page }) => {
		const cpus = 8
		const memoryGiB = 16
		await openE2eProject(page)
		await setProjectSandbox(page, 'VM (Docker inside)')
		await openE2eProject(page)
		const taskId = await startTask(page, {
			prompt: 'Run nproc and report its output.',
			vm: 'Own VM',
			vmResources: { cpus, memoryGiB },
		})
		await waitForTurnEnd(page, 40 * 60_000)
		const guest = spawnSync(
			'limactl',
			['shell', taskVmName(taskId), '--', 'sh', '-c', "nproc && awk '/^MemTotal:/ { print $2 }' /proc/meminfo"],
			{ encoding: 'utf8', timeout: 30_000 },
		)
		expect(guest.status, guest.stderr).toBe(0)
		const [onlineCpus, totalKiB] = guest.stdout.trim().split(/\s+/).map(Number)
		expect(onlineCpus).toBe(cpus)
		// Linux excludes kernel-reserved memory from MemTotal.
		expect(totalKiB).toBeGreaterThan((memoryGiB - 1) * 1024 ** 2)
		expect(totalKiB).toBeLessThanOrEqual(memoryGiB * 1024 ** 2)
		await archiveTask(page, taskId)
	})

	test("a task runs Docker in its own VM, the VM's port opens on the host, and archiving deletes the VM", async ({
		page,
	}) => {
		await openE2eProject(page)
		await setProjectSandbox(page, 'VM (Docker inside)')
		await openE2eProject(page)
		const taskId = await startTask(page, {
			prompt: 'Run `docker run -d -p 18080:80 --name e2e-web nginx:alpine`, wait until `curl -s localhost:18080` answers, then reply with only the word ok if the page mentions nginx.',
			vm: 'Own VM',
		})
		await waitForTurnEnd(page, 40 * 60_000)
		await expect(page.getByText(/^ok\.?$/i).first()).toBeVisible()
		expect(limactlList()).toContain(taskVmName(taskId))
		// The container runs in the VM, not on the host's Docker.
		expect(spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout).not.toContain(
			'e2e-web',
		)

		// The daemon forwards the port and reports it with its heartbeat (every 15 s).
		const port = page.getByRole('link', { name: /^:18080/ })
		await expect(port).toBeVisible({ timeout: 90_000 })
		const href = await port.getAttribute('href')
		expect(href).toMatch(/^http:\/\/localhost:\d+$/)
		const body = await (await fetch(href!)).text()
		expect(body).toContain('nginx')

		await archiveTask(page, taskId)
		await expect.poll(() => limactlList().includes(taskVmName(taskId)), { timeout: 180_000 }).toBe(false)
	})
})
