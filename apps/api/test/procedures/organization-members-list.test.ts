import { call } from '@orpc/server'
import { describe, expect, test } from 'vitest'

import { listActiveOrgMembersProcedure, listOrgMembersProcedure } from '../../src/orpc/api/org/members-list'
import { createMockApiContext, UserDirectory } from '../mocks'

describe('organization member lists', () => {
	test('lists every member of the organization and filters the active list by membership status', async () => {
		const directory = new UserDirectory()
		directory.addOrganization({ id: 'org-current', name: 'Current organization' })
		directory.addOrganization({ id: 'org-other', name: 'Other organization' })

		for (const [id, email] of [
			['user-active', 'active@example.com'],
			['user-inactive', 'inactive@example.com'],
			['user-other-org', 'other@example.com'],
		] as const) {
			directory.addUser({ id, email })
		}

		directory.addMembership({ userId: 'user-active', organizationId: 'org-current', status: 'active' })
		directory.addMembership({ userId: 'user-inactive', organizationId: 'org-current', status: 'inactive' })
		directory.addMembership({ userId: 'user-other-org', organizationId: 'org-other', status: 'active' })

		const context = createMockApiContext({
			auth: { workosOrganizationId: 'org-current' },
			services: { directory },
		})

		const [allResult, activeResult] = await Promise.all([
			call(listOrgMembersProcedure, {}, { context }),
			call(listActiveOrgMembersProcedure, {}, { context }),
		])

		expect(allResult.members.map((member) => member.id)).toEqual(['user-active', 'user-inactive'])
		expect(activeResult.members.map((member) => member.id)).toEqual(['user-active'])
	})
})
