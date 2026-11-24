import { organizations } from '@devflow/db/tables/organizations'
import { call } from '@orpc/server'
import { Redacted } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { getAuthContext } from '../../src/auth/context'
import { createPersonalAccessToken } from '../../src/auth/personal-access-tokens'
import { getOrgSettingsEffectProcedure as liveGetOrganizationSettingsProcedure } from '../../src/orpc/api/auth/admin/organizations-settings-get.effect'
import { listAdminUsersProcedure } from '../../src/orpc/api/auth/admin/users-list'
import { createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('user auth context resolution', () => {
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let tokenValue = ''

	beforeAll(async () => {
		const testDb = await createTestDb('pat_auth_context')
		cleanup = testDb.cleanup
		await testDb.db.insert(organizations).values({
			name: 'PAT context organization',
			workos_organization_id: 'workos_org_context',
		})
		runtime = createRuntimeWithTestPostgresLayer(testDb.db)
		const created = await runtime.runPromise(
			createPersonalAccessToken({
				userId: 'user_context',
				workosOrganizationId: 'workos_org_context',
				name: 'Actions',
				expiresInDays: 7,
			}),
		)
		tokenValue = Redacted.value(created.value)
	}, 60_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	}, 30_000)

	test('resolves a PAT on every request to a non-admin organization context', async () => {
		if (!runtime) throw new Error('Test runtime was not initialized')
		const request = new Request('http://localhost/rpc/api/v1/auth/user/info', {
			headers: { authorization: `Bearer ${tokenValue}` },
		})

		const first = await getAuthContext(request, runtime)
		const second = await getAuthContext(request, runtime)

		expect(first).toEqual(second)
		expect(first).toMatchObject({
			userId: 'user_context',
			workosOrganizationId: 'workos_org_context',
			role: 'member',
			roles: ['member'],
		})
	})

	test('rejects an unknown PAT', async () => {
		if (!runtime) throw new Error('Test runtime was not initialized')
		const request = new Request('http://localhost', { headers: { authorization: 'Bearer dfpat_unknown' } })
		expect(await getAuthContext(request, runtime)).toBeNull()
	})

	test('uses the same classic and Effect admin authorization bases and remains non-admin', async () => {
		if (!runtime) throw new Error('Test runtime was not initialized')
		const auth = await getAuthContext(
			new Request('http://localhost', { headers: { authorization: `Bearer ${tokenValue}` } }),
			runtime,
		)
		if (!auth?.organizationId || !auth.workosOrganizationId) throw new Error('Expected an organization context')
		const context = createMockApiContext({ auth })

		await expect(call(listAdminUsersProcedure, {}, { context })).rejects.toMatchObject({ code: 'FORBIDDEN' })

		const getOrganizationSettingsProcedure = bindProcedureToRuntime(liveGetOrganizationSettingsProcedure, runtime)
		await expect(call(getOrganizationSettingsProcedure, {}, { context })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
	})
})
