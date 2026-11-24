import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

import { artifactSidePanelTrace, setArtifactTraceEnabled } from './artifact-side-panel-trace'

describe('artifact side-panel trace runtime', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.stubGlobal(
			'MutationObserver',
			class {
				observe() {}
				disconnect() {}
			},
		)
		setArtifactTraceEnabled(false)
		artifactSidePanelTrace.clear()
		setArtifactTraceEnabled(true)
	})

	afterEach(() => {
		setArtifactTraceEnabled(false)
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('offers the download once the capture window after the latest mark ends', async () => {
		expect(artifactSidePanelTrace.mark()).toBe(true)
		await vi.advanceTimersByTimeAsync(4_999)
		expect(artifactSidePanelTrace.status().output.phase).toBe('capturing')

		expect(artifactSidePanelTrace.mark()).toBe(true)
		await vi.advanceTimersByTimeAsync(4_999)
		expect(artifactSidePanelTrace.status().output.phase).toBe('capturing')
		await vi.advanceTimersByTimeAsync(1)
		expect(artifactSidePanelTrace.status().output).toEqual({
			phase: 'ready-download',
			savedPath: null,
			error: null,
		})
	})
})
