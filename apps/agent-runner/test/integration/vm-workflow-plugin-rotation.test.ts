import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import type { LimaRunner } from '@/devflow/vm-sandbox'
import { ensureVmWorkflowPlugin } from '@/devflow/vm-workflow-plugin'

const vm = process.env.DEVFLOW_TEST_LIMA_VM

test.skipIf(!vm)('repeated skill updates replace one read-only mount in a running Lima guest', async () => {
	if (!vm) throw new Error('Set DEVFLOW_TEST_LIMA_VM to an already running Lima VM.')
	const lima: LimaRunner = async (args, timeout, stdin) => {
		const result = spawnSync(process.env.DEVFLOW_LIMACTL ?? 'limactl', ['--tty=false', ...args], {
			encoding: 'utf8',
			stdio: [stdin ?? 'ignore', 'pipe', 'pipe'],
			timeout,
		})
		if (result.error) throw result.error
		return { code: result.status, stdout: result.stdout, stderr: result.stderr }
	}
	// Simulate a guest without the atomic mount syscall; use the same kernel mounts and production fallback.
	const olderKernel: LimaRunner = (args, timeout, stdin) => {
		const command = [...args]
		const script = command.indexOf('-c') + 1
		if (script && command.includes('sudo')) command[script] = 'python3() { return 127; }\n' + command[script]
		return lima(command, timeout, stdin)
	}
	const guest = async (...command: string[]) => {
		const result = await lima(['shell', '--workdir=/', vm, '--', ...command], 30_000)
		if (result.code !== 0) throw new Error(result.stderr)
		return result.stdout.trim()
	}
	// Devflow VMs have a private /tmp. Reproduce a stale mount with an empty directory at the host's path.
	const plugin = mkdtempSync('/tmp/devflow-plugin-rotation-')
	try {
		await guest('mkdir', '--', plugin)
		try {
			for (const revision of ['first', 'second', 'third']) {
				writeFileSync(join(plugin, 'SKILL.md'), revision)
				if (revision === 'second') {
					expect(await ensureVmWorkflowPlugin(olderKernel, vm, plugin, true)).toBe(false)
					expect(await guest('cat', join(plugin, 'SKILL.md'))).toBe('first')
				}
				expect(await ensureVmWorkflowPlugin(revision === 'third' ? olderKernel : lima, vm, plugin)).toBe(true)
				expect(await guest('cat', join(plugin, 'SKILL.md'))).toBe(revision)
				const mounts = await guest('cat', '/proc/self/mountinfo')
				expect(mounts.split('\n').filter((line) => line.split(' ')[4] === plugin)).toHaveLength(1)
				expect((await guest('findmnt', '-nro', 'OPTIONS', '-T', plugin)).split(',')).toContain('ro')
			}
		} finally {
			await guest(
				'sh',
				'-ec',
				'while mountpoint -q -- "$1"; do sudo umount -l -- "$1"; done; rmdir -- "$1"',
				'sh',
				plugin,
			)
		}
	} finally {
		rmSync(plugin, { recursive: true, force: true })
	}
})
