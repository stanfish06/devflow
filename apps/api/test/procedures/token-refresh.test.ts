import { call } from '@orpc/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../../src/devflow/local-auth', () => ({
	issueLocalAccessToken: vi.fn(async () => ({ accessToken: 'access-new', expiresAt: 0 })),
}))

import { refreshTokenProcedure } from '../../src/orpc/api/auth/token-refresh'
import { createMockApiContextNoOrg } from '../mocks'

describe('refreshToken', () => {
	test('issues a new local access token and returns the refresh token unchanged', async () => {
		const context = createMockApiContextNoOrg({ auth: null })

		const result = await call(refreshTokenProcedure, { refreshToken: 'refresh-old' }, { context })

		expect(result).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-old' })
	})
})
