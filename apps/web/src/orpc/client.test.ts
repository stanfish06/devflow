import { ORPCError } from '@orpc/client'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import { handleApiError } from './client'

vi.mock('sonner', () => ({
	toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

describe('handleApiError UNAUTHORIZED', () => {
	it('shows nothing and stays on the page', () => {
		const navigate = vi.fn()

		handleApiError(new ORPCError('UNAUTHORIZED'), undefined, { navigate, isOnOrgPages: false })

		expect(toast.warning).not.toHaveBeenCalled()
		expect(toast.error).not.toHaveBeenCalled()
		expect(navigate).not.toHaveBeenCalled()
	})
})
