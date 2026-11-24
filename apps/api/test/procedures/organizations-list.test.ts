import { call, isDefinedError } from '@orpc/server'
import { describe, expect, test } from 'vitest'

import { listUserOrganizationsProcedure } from '../../src/orpc/api/auth/user/organizations-list'
import { createMockApiContextNoOrg, UserDirectory } from '../mocks'

function directoryWithOrganization() {
	const directory = new UserDirectory()
	directory.addUser({ id: 'user-123', email: 'user@example.com' })
	directory.addOrganization({ id: 'org-1', name: 'Local Org' })
	directory.addMembership({ userId: 'user-123', organizationId: 'org-1', role: 'admin' })
	return directory
}

describe('listUserOrganizations', () => {
	test("returns the user's organization from the directory", async () => {
		const context = createMockApiContextNoOrg({
			auth: { userId: 'user-123' },
			services: { directory: directoryWithOrganization() },
		})

		const result = await call(listUserOrganizationsProcedure, {}, { context })

		expect(result.organizations).toEqual([
			{
				organizationId: 'org-1',
				organizationName: 'Local Org',
				role: 'admin',
				signInUrl: expect.any(String),
				domains: [],
			},
		])
		expect(result.activeOrganizationId).toBeNull()
	})

	test('returns activeOrganizationId when user has active org', async () => {
		const context = createMockApiContextNoOrg({
			auth: { userId: 'user-123', organizationId: 'org-1' },
			services: { directory: directoryWithOrganization() },
		})

		const result = await call(listUserOrganizationsProcedure, {}, { context })

		expect(result.activeOrganizationId).toBe('org-1')
	})

	test('throws UNAUTHORIZED when auth is null', async () => {
		const context = createMockApiContextNoOrg({ auth: null })

		try {
			await call(listUserOrganizationsProcedure, {}, { context })
			expect.unreachable('Should have thrown')
		} catch (err) {
			expect(isDefinedError(err)).toBe(true)
			expect((err as { code: string }).code).toBe('UNAUTHORIZED')
		}
	})
})
