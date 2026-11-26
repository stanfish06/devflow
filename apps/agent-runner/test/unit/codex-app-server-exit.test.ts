import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { AppServerClient } from '@/devflow/codex-app-server'

describe('Codex app-server exit diagnostics', () => {
	it('delivers the terminal stderr diagnostic to pending RPCs and to the turn without exposing child output', async () => {
		const child = spawn(process.execPath, [
			'-e',
			`
			process.stdin.once('data', () => {
				process.stderr.write('No space left on device\\n' + 'x'.repeat(20_000) + '\\n')
				process.stderr.end('OPENAI_API_KEY=private-value\\nwrapper: exec: codex: not found\\n', () => process.exit(127))
			})
		`,
		])
		const client = new AppServerClient(child)
		const turnError = new Promise<Error>((resolve) => client.onExit(resolve))
		const rpcError = client.request('initialize', {}).catch((error: Error) => error)
		const error = await turnError
		expect(await rpcError).toBe(error)
		expect(error.message).toBe('codex app-server exited (code 127): codex: not found')
		await expect(client.request('thread/start', {})).rejects.toBe(error)
		expect(await client.whenExited()).toBe(127)
	})

	it.each(['SQLITE_IOERR_SHORT_READ', 'database disk image is malformed', 'disk I/O error', 'database is locked'])(
		'retains SQLite failure %s and excludes unrelated earlier stderr',
		async (diagnostic) => {
			const client = new AppServerClient(
				spawn(process.execPath, [
					'-e',
					`process.stderr.write('WARN startup recovery: permission denied\\nERROR: ' + process.argv[1] + '\\n'); process.exitCode = 1`,
					diagnostic,
				]),
			)
			const error = await new Promise<Error>((resolve) => client.onExit(resolve))
			expect(error.message).toBe(`codex app-server exited (code 1): ${diagnostic}`)
		},
	)

	it('omits startup recovery warnings when there is no terminal error diagnostic', async () => {
		const client = new AppServerClient(
			spawn(process.execPath, [
				'-e',
				"process.stderr.write('WARN Codex rebuilt its local database: IOERR_SHORT_READ'); process.exitCode = 1",
			]),
		)
		const error = await new Promise<Error>((resolve) => client.onExit(resolve))
		expect(error.message).toBe('codex app-server exited (code 1)')
	})

	it('retains a spawn error for handlers installed after the failure', async () => {
		const client = new AppServerClient(spawn('/nonexistent-dir/codex-app-server'))
		const request = client.request('initialize', {})
		await expect(request).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await client.whenExited()).toBeNull()
		const late = await new Promise<Error>((resolve) => client.onExit(resolve))
		expect(late).toMatchObject({ code: 'ENOENT' })
	})

	it('keeps a terminal stderr diagnostic delivered ahead of a buffered RPC response', async () => {
		const child = Object.assign(new ChildProcess(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		})
		const client = new AppServerClient(child)
		const exited = new Promise<Error>((resolve) => client.onExit(resolve))
		const started = client.request('turn/start', {})
		child.stderr.write('ERROR: database disk image is malformed\n')
		child.stdout.write(JSON.stringify({ id: 1, result: { turn: { id: 't' } } }) + '\n')
		await expect(started).resolves.toEqual({ turn: { id: 't' } })
		child.emit('close', 1, null)
		expect((await exited).message).toContain('database disk image is malformed')
	})

	it('reports late stderr after a live turn loses its process, even if a descendant holds its pipes open', async () => {
		vi.useFakeTimers()
		try {
			const child = Object.assign(new ChildProcess(), {
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			})
			const client = new AppServerClient(child)
			const turnError = new Promise<Error>((resolve) => client.onExit(resolve))
			const turn = client.request('turn/start', {})
			child.stderr.write('WARN Codex rebuilt its local database: database disk image is malformed\n')
			child.stdout.write(JSON.stringify({ id: 1, result: { turn: { id: 'active' } } }) + '\n')
			await expect(turn).resolves.toEqual({ turn: { id: 'active' } })
			child.emit('exit', null, 'SIGTERM')
			child.stderr.write('worker: Permission denied')
			// No close event: the descendant still holds stdout. Finish within the shutdown drain.
			await vi.advanceTimersByTimeAsync(1_000)
			expect((await turnError).message).toBe('codex app-server exited (SIGTERM): Permission denied')
			expect(await client.whenExited()).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})
})
