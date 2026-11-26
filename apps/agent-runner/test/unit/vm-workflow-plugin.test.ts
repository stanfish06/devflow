import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import type { LimaRunner } from '@/devflow/vm-sandbox'
import { ensureVmWorkflowPlugin } from '@/devflow/vm-workflow-plugin'

let root: string
let host: string
let guest: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'vm-plugin-'))
	host = join(root, 'source')
	guest = join(root, 'mount')
	mkdirSync(join(host, 'skills', 'phase'), { recursive: true })
	writeFileSync(join(host, 'skills', 'phase', 'SKILL.md'), 'Approve the document and begin the next phase.')
	writeFileSync(join(host, 'helper'), '#!/bin/sh\necho started\n', { mode: 0o755 })
	symlinkSync('skills/phase/SKILL.md', join(host, 'current'))
	cpSync(host, guest, { recursive: true, verbatimSymlinks: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Run the actual guest probe with Node. Extract each transmitted archive into the stand-in mount.
function guestTransport() {
	let transfers = 0
	const run: LimaRunner = async (args, _, input) => {
		const executable = args.indexOf('--') + 1
		if (args[executable] === 'node') {
			const command = args.slice(executable + 1).map((arg) => (arg === host ? guest : arg))
			const result = spawnSync('node', command, { encoding: 'utf8' })
			return { code: result.status, stdout: result.stdout, stderr: result.stderr }
		}
		if (typeof input !== 'number') throw new Error('The guest must receive the archive from the host')
		transfers++
		rmSync(guest, { recursive: true })
		mkdirSync(guest)
		const result = spawnSync('tar', ['-C', guest, '-xf', '-'], { stdio: [input, 'pipe', 'pipe'], encoding: 'utf8' })
		return { code: result.status, stdout: result.stdout, stderr: result.stderr }
	}
	return { run, transfers: () => transfers }
}

test.each(['missing files', 'stale skill contents', 'changed script mode', 'changed link target', 'extra link'])(
	'delivers a fresh snapshot for %s and reuses matching bytes on the next lease',
	async (change) => {
		const transport = guestTransport()
		await ensureVmWorkflowPlugin(transport.run, 'vm', host)
		expect(transport.transfers()).toBe(0)
		if (change === 'missing files') rmSync(join(guest, 'skills'), { recursive: true })
		if (change === 'stale skill contents') writeFileSync(join(guest, 'skills', 'phase', 'SKILL.md'), 'old')
		if (change === 'changed script mode') chmodSync(join(guest, 'helper'), 0o644)
		if (change === 'changed link target') {
			rmSync(join(guest, 'current'))
			symlinkSync('helper', join(guest, 'current'))
		}
		if (change === 'extra link') symlinkSync('helper', join(guest, 'unexpected'))
		await ensureVmWorkflowPlugin(transport.run, 'vm', host)
		expect(readFileSync(join(guest, 'current'), 'utf8')).toBe(readFileSync(join(host, 'current'), 'utf8'))
		await ensureVmWorkflowPlugin(transport.run, 'vm', host)
		expect(transport.transfers()).toBe(1)
	},
)

test('does not copy an external symlink into a repaired mount', async () => {
	writeFileSync(join(root, 'external'), 'outside')
	symlinkSync('../external', join(host, 'external'))
	const transport = guestTransport()
	await expect(ensureVmWorkflowPlugin(transport.run, 'vm', host)).rejects.toThrow(/outside its root/)
	expect(transport.transfers()).toBe(0)
})

test('reports an SSH error without copying into the guest', async () => {
	const failed: LimaRunner = async () => ({ code: 255, stdout: '', stderr: 'connection closed' })
	await expect(ensureVmWorkflowPlugin(failed, 'vm', host)).rejects.toThrow(/connection closed/)
})
