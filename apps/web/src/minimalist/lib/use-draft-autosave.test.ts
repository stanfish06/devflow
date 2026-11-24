import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DraftLaunch } from '@/minimalist/lib/launch-form'

import { AUTOSAVE_DELAY_MS, DRAFT_GONE_MESSAGE, type DraftRowFields, useDraftAutosave } from './use-draft-autosave'

const { saveDraft, showToast } = vi.hoisted(() => ({ saveDraft: vi.fn(), showToast: vi.fn() }))

vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: { tasks: { saveDraft } } }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))

const taskId = '019ab7c2-4f1e-7000-8000-00000000d1a7'

function snapshot(prompt: string): DraftLaunch {
	return {
		version: 1,
		prompt,
		attachments: [],
		target: { kind: 'directory', path: '/code/app' },
		hostId: 'host',
		settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'default' },
		taskSize: 'medium',
		smallAutoAdvance: true,
	}
}

type Props = { id: string | null; prompt: string; row: DraftRowFields }
const todo: DraftRowFields = { ticket: null, status: 'todo' }

function renderAutosave(initial: Partial<Props> = {}) {
	return renderHook((props: Props) => useDraftAutosave(props.id, snapshot(props.prompt), props.row), {
		initialProps: { id: taskId, prompt: 'Opened', row: todo, ...initial },
	})
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const savedPrompts = () =>
	saveDraft.mock.calls.map((call) => (call[0] as { draftLaunch: DraftLaunch }).draftLaunch.prompt)

beforeEach(() => {
	vi.useFakeTimers()
	vi.clearAllMocks()
	saveDraft.mockResolvedValue({ result: 'saved', transactionId: '1', task: { id: taskId } })
})

afterEach(() => {
	vi.useRealTimers()
})

describe('autosaving an open draft', () => {
	it('saves once typing pauses, with the latest text and the column the card is in', async () => {
		const { result, rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Opened, edited', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2))
		rerender({ id: taskId, prompt: 'Opened, edited again', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2))
		expect(saveDraft).not.toHaveBeenCalled()
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['Opened, edited again'])
		expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({ id: taskId, status: 'todo', name: 'Opened, edited again' })
		expect(result.current.state).toBe('saved')
		expect(result.current.savedAt).toEqual(expect.any(Number))
	})

	it("doesn't save what the row already holds", async () => {
		const { rerender } = renderAutosave()
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2))
		rerender({ id: taskId, prompt: 'Typed', row: todo })
		rerender({ id: taskId, prompt: 'Opened', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2))
		expect(saveDraft).not.toHaveBeenCalled()
	})

	it('keeps a card where it was dragged: each save sends the column it is in then', async () => {
		const { rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Edited', row: todo })
		// Dragged to On hold on the board while the draft is open; the row syncs before the save goes.
		rerender({ id: taskId, prompt: 'Edited', row: { ticket: null, status: 'on_hold' } })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(saveDraft.mock.calls[0]?.[0]).toMatchObject({ status: 'on_hold' })
	})

	it('sends one save at a time, then one more with the edits made meanwhile', async () => {
		const first = deferred<unknown>()
		saveDraft.mockReturnValueOnce(first.promise)
		const { rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'One', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['One'])
		rerender({ id: taskId, prompt: 'Two', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		rerender({ id: taskId, prompt: 'Three', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['One'])
		await act(async () => first.resolve({ result: 'saved', transactionId: '1', task: { id: taskId } }))
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['One', 'Three'])
	})

	it('goes back to what the row held when an edit is undone while a save is out', async () => {
		const first = deferred<unknown>()
		saveDraft.mockReturnValueOnce(first.promise)
		const { rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Typo', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		rerender({ id: taskId, prompt: 'Opened', row: todo })
		await act(async () => first.resolve({ result: 'saved', transactionId: '1', task: { id: taskId } }))
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['Typo', 'Opened'])
	})

	it('stops when the draft was started or deleted elsewhere, and says so', async () => {
		saveDraft.mockResolvedValue({ result: 'draft-id-unavailable' })
		const { result, rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Edited', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(showToast).toHaveBeenCalledWith(DRAFT_GONE_MESSAGE)
		expect(result.current.state).toBe('error')
		rerender({ id: taskId, prompt: 'Edited again', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		await act(() => result.current.flush())
		expect(saveDraft).toHaveBeenCalledOnce()
	})

	it('tries again on the next edit after a failed save', async () => {
		saveDraft.mockRejectedValueOnce(new Error('offline'))
		const { result, rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Edited', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(result.current.state).toBe('error')
		expect(showToast).not.toHaveBeenCalled()
		rerender({ id: taskId, prompt: 'Edited more', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(savedPrompts()).toEqual(['Edited', 'Edited more'])
		expect(result.current.state).toBe('saved')
	})

	it('flush saves a pending edit at once and resolves once it landed', async () => {
		const save = deferred<unknown>()
		saveDraft.mockReturnValueOnce(save.promise)
		const { result, rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Start this', row: todo })
		let flushed = false
		let flushing: Promise<void> = Promise.resolve()
		act(() => {
			flushing = result.current.flush().then(() => {
				flushed = true
			})
		})
		expect(savedPrompts()).toEqual(['Start this'])
		await act(async () => Promise.resolve())
		expect(flushed).toBe(false)
		await act(async () => {
			save.resolve({ result: 'saved', transactionId: '1', task: { id: taskId } })
			await flushing
		})
		expect(flushed).toBe(true)
		// The debounced save that was pending has nothing left to send.
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		expect(saveDraft).toHaveBeenCalledOnce()
	})

	it('flush resolves false when the save fails, and true once a retry lands', async () => {
		saveDraft.mockRejectedValueOnce(new Error('offline'))
		const { result, rerender } = renderAutosave()
		rerender({ id: taskId, prompt: 'Unsaved edit', row: todo })
		let landed: boolean | undefined
		await act(async () => {
			landed = await result.current.flush()
		})
		expect(landed).toBe(false)
		await act(async () => {
			landed = await result.current.flush()
		})
		expect(landed).toBe(true)
		expect(savedPrompts()).toEqual(['Unsaved edit', 'Unsaved edit'])
	})

	it('saves a pending edit when the page goes away', async () => {
		const { rerender, unmount } = renderAutosave()
		rerender({ id: taskId, prompt: 'Left mid-sentence', row: todo })
		unmount()
		await act(() => vi.advanceTimersByTimeAsync(0))
		expect(savedPrompts()).toEqual(['Left mid-sentence'])
	})

	it('does nothing while turned off', async () => {
		const { result, rerender } = renderAutosave({ id: null })
		rerender({ id: null, prompt: 'Edited', row: todo })
		await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS))
		await act(() => result.current.flush())
		expect(saveDraft).not.toHaveBeenCalled()
	})
})
