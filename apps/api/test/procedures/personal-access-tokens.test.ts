import { organizations } from '@devflow/db/tables/organizations'
import { call } from '@orpc/server'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createPersonalAccessTokenProcedure as liveCreateProcedure } from '../../src/orpc/api/auth/user/personal-access-tokens-create.effect'
import { listPersonalAccessTokensProcedure as liveListProcedure } from '../../src/orpc/api/auth/user/personal-access-tokens-list.effect'
import { revokePersonalAccessTokenProcedure as liveRevokeProcedure } from '../../src/orpc/api/auth/user/personal-access-tokens-revoke.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('personal access token procedures', () => {
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let organizationId = ''
	let createdId = ''

	beforeAll(async () => {
		const testDb = await createTestDb('pat_procedures')
		cleanup = testDb.cleanup
		const [organization] = await testDb.db
			.insert(organizations)
			.values({ name: 'PAT procedures', workos_organization_id: 'workos_org_procedure' })
			.returning()
		if (!organization) throw new Error('Failed to create test organization')
		organizationId = organization.id

		runtime = createRuntimeWithTestPostgresLayer(testDb.db)
	}, 60_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanup?.()
	}, 30_000)

	function context() {
		return createMockApiContext({
			auth: createMockApiAuth({
				userId: 'user_procedure',
				organizationId,
				workosOrganizationId: 'workos_org_procedure',
			}),
		})
	}

	test('creates a one-time value and lists metadata without the raw secret', async () => {
		if (!runtime) throw new Error('Test runtime was not initialized')
		const createProcedure = bindProcedureToRuntime(liveCreateProcedure, runtime)
		const listProcedure = bindProcedureToRuntime(liveListProcedure, runtime)

		const created = await call(createProcedure, { name: 'Actions', expiresInDays: 7 }, { context: context() })
		expect(created).toMatchObject({ token: { name: 'Actions' }, value: expect.stringMatching(/^dfpat_/) })
		createdId = created.token.id

		const listed = await call(listProcedure, {}, { context: context() })
		expect(listed.tokens).toEqual([expect.objectContaining({ id: createdId })])
		expect(listed.tokens[0]).not.toHaveProperty('value')
	})

	test('permanently revokes an owned key and maps an unknown key to NOT_FOUND', async () => {
		if (!runtime) throw new Error('Test runtime was not initialized')
		const revokeProcedure = bindProcedureToRuntime(liveRevokeProcedure, runtime)

		await expect(call(revokeProcedure, { id: createdId }, { context: context() })).resolves.toEqual({
			success: true,
		})
		const listProcedure = bindProcedureToRuntime(liveListProcedure, runtime)
		expect((await call(listProcedure, {}, { context: context() })).tokens).toEqual([])
		await expect(call(revokeProcedure, { id: 'unknown' }, { context: context() })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})
})
