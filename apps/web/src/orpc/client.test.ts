import { ORPCError } from '@orpc/client'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import { handleApiError } from './client'

vi.mock('sonner', () => ({
	toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

describe('handleApiError UNAUTHORIZED', () => {
	it('shows nothing', () => {
		handleApiError(new ORPCError('UNAUTHORIZED'), undefined)

		expect(toast.warning).not.toHaveBeenCalled()
		expect(toast.error).not.toHaveBeenCalled()
	})
})
