import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyAsyncTextToClipboard } from './clipboard'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('copyAsyncTextToClipboard', () => {
	it('starts an async ClipboardItem write immediately in the browser', async () => {
		const write = vi.fn().mockResolvedValue(undefined)
		const writeText = vi.fn()
		const clipboardItem = vi.fn()
		vi.stubGlobal('navigator', { clipboard: { write, writeText } })
		vi.stubGlobal('ClipboardItem', clipboardItem)

		await copyAsyncTextToClipboard(Promise.resolve('https://example.com/shared'))

		expect(clipboardItem).toHaveBeenCalledOnce()
		expect(write).toHaveBeenCalledOnce()
		expect(writeText).not.toHaveBeenCalled()
	})
})
