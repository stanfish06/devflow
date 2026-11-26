import { describe, expect, it, vi } from 'vitest'

import {
	CodexSessionClosedError,
	type CodexSessionProcess,
	CodexSessionProcesses,
} from '@/devflow/codex-session-processes'

function appServer() {
	const exited = Promise.withResolvers<void>()
	return {
		exit: () => exited.resolve(),
		whenExited: () => exited.promise,
		close: vi.fn(async () => {}),
	}
}

describe('Codex session processes', () => {
	it('opens once for concurrent replies and grants each turn exclusive access in arrival order', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const cold = Promise.withResolvers<CodexSessionProcess>()
		const open = vi.fn(() => cold.promise)
		const first = registry.acquire('task', open)
		const secondReady = vi.fn()
		const thirdReady = vi.fn()
		const second = registry.acquire('task', open).then((slot) => {
			secondReady()
			return slot
		})
		const third = registry.acquire('task', open).then((slot) => {
			thirdReady()
			return slot
		})
		const process = appServer()
		cold.resolve(process)
		const firstSlot = await first
		expect(open).toHaveBeenCalledTimes(1)
		expect(secondReady).not.toHaveBeenCalled()
		await firstSlot.release()
		const secondSlot = await second
		await firstSlot.release(true)
		expect(thirdReady).not.toHaveBeenCalled()
		expect(process.close).not.toHaveBeenCalled()
		await secondSlot.release()
		const thirdSlot = await third
		expect(thirdSlot.process).toBe(process)
		await thirdSlot.release(true)
		expect(process.close).toHaveBeenCalledTimes(1)
	})

	it('finishes the active turn and cleanup before opening a replacement on retirement', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const old = appServer()
		const replacement = appServer()
		const closing = Promise.withResolvers<void>()
		old.close.mockImplementation(() => closing.promise)
		const slot = await registry.acquire('task', async () => old)
		const open = vi.fn(async () => replacement)
		const next = registry.acquire('task', open)
		const retired = registry.retire('task')
		expect(slot.wasCancelled()).toBe(false)
		expect(old.close).not.toHaveBeenCalled()
		const released = slot.release()
		expect(slot.release()).toBe(released)
		await Promise.resolve()
		expect(old.close).toHaveBeenCalledTimes(1)
		expect(open).not.toHaveBeenCalled()
		closing.resolve()
		await Promise.all([released, retired])
		const nextSlot = await next
		old.exit()
		await nextSlot.release()
		const reused = await registry.acquire('task', open)
		expect(reused.process).toBe(replacement)
		expect(open).toHaveBeenCalledTimes(1)
		await reused.release(true)
	})

	it('rejects queued turns and closes immediately on forced loss even if the old holder returns later', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const old = appServer()
		const holder = await registry.acquire('task', async () => old)
		const open = vi.fn(async () => appServer())
		const queued = expect(registry.acquire('task', open)).rejects.toBeInstanceOf(CodexSessionClosedError)
		await Promise.all([registry.forceClose('task'), queued])
		expect(open).not.toHaveBeenCalled()
		const replacement = await registry.acquire('task', open)
		expect(holder.wasCancelled()).toBe(true)
		expect(replacement.wasCancelled()).toBe(false)
		await holder.release(true)
		expect(old.close).toHaveBeenCalledTimes(1)
		expect(replacement.process.close).not.toHaveBeenCalled()
		await replacement.release(true)
	})

	it('cleans up after spontaneous exit while the turn holder is still awaiting a response', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const old = appServer()
		const closed = Promise.withResolvers<void>()
		old.close.mockImplementation(async () => {
			await old.whenExited()
			closed.resolve()
		})
		const holder = await registry.acquire('task', async () => old)
		const queued = expect(registry.acquire('task', async () => appServer())).rejects.toThrow('was closed')
		old.exit()
		await Promise.all([closed.promise, queued])
		expect(holder.wasCancelled()).toBe(false)
		await holder.release()
		expect(old.close).toHaveBeenCalledTimes(1)
	})

	it('shuts down active and still-opening sessions and rejects later acquisitions', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const running = appServer()
		const active = await registry.acquire('active', async () => running)
		const cold = Promise.withResolvers<CodexSessionProcess>()
		const opening = expect(registry.acquire('cold', () => cold.promise)).rejects.toBeInstanceOf(
			CodexSessionClosedError,
		)
		const stopped = registry.shutdown()
		expect(active.wasCancelled()).toBe(true)
		await expect(registry.acquire('late', async () => appServer())).rejects.toBeInstanceOf(CodexSessionClosedError)
		const late = appServer()
		cold.resolve(late)
		await Promise.all([stopped, registry.shutdown(), opening])
		expect(running.close).toHaveBeenCalledTimes(1)
		expect(late.close).toHaveBeenCalledTimes(1)
	})

	it('reports an unexpected exit during initial acquisition as a process failure', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		const process = appServer()
		process.exit()
		const opening = registry.acquire('task', async () => process)
		await expect(opening).rejects.toThrow('was closed')
		await expect(opening).rejects.not.toBeInstanceOf(CodexSessionClosedError)
		expect(process.close).toHaveBeenCalledTimes(1)
	})

	it('allows a fresh open after a failed factory', async () => {
		const registry = new CodexSessionProcesses<CodexSessionProcess>()
		await expect(
			registry.acquire('task', async () => {
				throw new Error('open failed')
			}),
		).rejects.toThrow('open failed')
		const slot = await registry.acquire('task', async () => appServer())
		await slot.release(true)
	})
})
