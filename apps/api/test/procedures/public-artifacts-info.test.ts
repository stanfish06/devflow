import { randomUUID } from 'node:crypto'

import { artifacts } from '@devflow/db/tables/artifacts'
import { organizationSettings } from '@devflow/db/tables/organization-settings'
import { organizations } from '@devflow/db/tables/organizations'
import { call, ORPCError } from '@orpc/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hash } from 'ohash'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { artifactInfoProcedure } from '../../src/orpc/api/public/artifacts/info'
import { createMockApiAuth, createMockApiContext, UserDirectory } from '../mocks'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const uuid = () => randomUUID() as `${string}-${string}-${string}-${string}-${string}`

describe('public artifacts info', () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let organizationId: string
	let otherOrganizationId: string
	let artifactId: string

	beforeAll(async () => {
		const testDb = await createTestDb('public_artifacts_info')
		cleanupTestDb = testDb.cleanup
		db = testDb.db

		const [org] = await db
			.insert(organizations)
			.values({ name: 'Public Lookup Org', workos_organization_id: 'workos-public-lookup' })
			.returning()
		const [otherOrg] = await db
			.insert(organizations)
			.values({ name: 'Other Org', workos_organization_id: 'workos-other-lookup' })
			.returning()
		if (!org || !otherOrg) throw new Error('Failed to create organizations')

		organizationId = org.id
		otherOrganizationId = otherOrg.id

		const content = '# Private artifact'
		const [artifact] = await db
			.insert(artifacts)
			.values({
				organization_id: organizationId,
				resource_owner_user_id: 'artifact-owner',
				file_name: 'private.md',
				content,
				content_hash: hash(content),
				created_by: 'artifact-owner',
			})
			.returning()
		if (!artifact) throw new Error('Failed to create artifact')
		artifactId = artifact.id
	}, 60000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	const makeContext = (
		auth: ReturnType<typeof createMockApiAuth> | null,
		directory?: UserDirectory,
		requestIp: string = randomUUID(),
	) => ({
		...createMockApiContext({ auth, services: { db, dbReadReplica: db, ...(directory ? { directory } : {}) } }),
		requestIp,
	})

	test('throws NOT_FOUND for nonexistent artifact', async () => {
		try {
			await call(artifactInfoProcedure, { artifactId: uuid() }, { context: makeContext(null) })
			expect.unreachable('Expected NOT_FOUND')
		} catch (error) {
			expect(error).toBeInstanceOf(ORPCError)
			expect((error as ORPCError<any, any>).code).toBe('NOT_FOUND')
		}
	})

	test('returns accessible:true when caller in same org', async () => {
		const result = await call(
			artifactInfoProcedure,
			{ artifactId },
			{ context: makeContext(createMockApiAuth({ organizationId })) },
		)

		expect(result).toEqual({ exists: true, accessible: true })
	})

	test('returns inaccessible payload when caller in different org', async () => {
		const result = await call(
			artifactInfoProcedure,
			{ artifactId },
			{ context: makeContext(createMockApiAuth({ organizationId: otherOrganizationId })) },
		)

		expect(result).toEqual({
			exists: true,
			accessible: false,
			organizationName: 'Public Lookup Org',
			domain: null,
			myRequestStatus: 'none',
			lastRequestedAt: null,
		})
	})

	test('throws NOT_FOUND when org has feature disabled', async () => {
		const [disabledOrg] = await db
			.insert(organizations)
			.values({ name: 'Disabled Org', workos_organization_id: 'workos-disabled-lookup' })
			.returning()
		if (!disabledOrg) throw new Error('Failed to create disabled org')

		await db.insert(organizationSettings).values({
			organization_id: disabledOrg.id,
			access_requests_enabled: false,
		})

		const content = '# Disabled artifact'
		const [disabledArtifact] = await db
			.insert(artifacts)
			.values({
				organization_id: disabledOrg.id,
				resource_owner_user_id: 'artifact-owner',
				file_name: 'disabled.md',
				content,
				content_hash: hash(content),
				created_by: 'artifact-owner',
			})
			.returning()
		if (!disabledArtifact) throw new Error('Failed to create disabled artifact')

		try {
			await call(
				artifactInfoProcedure,
				{ artifactId: disabledArtifact.id },
				{ context: makeContext(createMockApiAuth({ organizationId: otherOrganizationId })) },
			)
			expect.unreachable('Expected NOT_FOUND')
		} catch (error) {
			expect(error).toBeInstanceOf(ORPCError)
			expect((error as ORPCError<any, any>).code).toBe('NOT_FOUND')
		}
	})

	test('returns inaccessible for anonymous caller without leaking myRequestStatus', async () => {
		const result = await call(artifactInfoProcedure, { artifactId }, { context: makeContext(null) })

		expect(result).toEqual({
			exists: true,
			accessible: false,
			organizationName: 'Public Lookup Org',
			domain: null,
			myRequestStatus: 'none',
			lastRequestedAt: null,
		})
	})

	test('prompts a member of the artifact organization to switch organizations', async () => {
		const directory = new UserDirectory()
		directory.addUser({ id: 'test-user-id', email: 'member@example.com' })
		directory.addOrganization({ id: 'workos-public-lookup', name: 'Public Lookup Org' })
		directory.addMembership({ userId: 'test-user-id', organizationId: 'workos-public-lookup' })

		const result = await call(
			artifactInfoProcedure,
			{ artifactId },
			{ context: makeContext(createMockApiAuth({ organizationId: otherOrganizationId }), directory) },
		)

		expect(result).toEqual({
			exists: true,
			accessible: true,
			requiresOrgSwitch: true,
			workosOrganizationId: 'workos-public-lookup',
			organizationName: 'Public Lookup Org',
		})
	})
})
