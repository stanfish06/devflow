import { contractBuilder } from '@devflow/api-contract/contract-builder'
import { call, implement, isDefinedError } from '@orpc/server'
import { describe, expect, test } from 'vitest'
import z from 'zod/v4'

import type { AuthContext, AuthContextOptionalOrg } from '../src/auth/jwt-validator'
import type { ApiContext } from '../src/orpc/base'
import { isAuthContextWithOrg, requireOrganization } from '../src/orpc/base'
import { createMockApiContext, createMockApiContextNoOrg } from './mocks'
import { requireExternalTestServices } from './utils/external-test-services'

await requireExternalTestServices()

// Bare auth literals retained ONLY for the isAuthContextWithOrg type-guard unit
// tests below — these exercise the guard directly, they do not build a context.
const mockAuthWithOrg: AuthContext = {
	userId: 'user-123',
	organizationId: 'org-456',
	workosOrganizationId: 'workos-org-789',
	role: '',
	roles: [],
	permissions: [],
	entitlements: [],
	sessionId: 'session-abc',
}

const mockAuthWithoutOrg: AuthContextOptionalOrg = {
	userId: 'user-123',
	organizationId: undefined,
	workosOrganizationId: undefined,
	role: '',
	roles: [],
	permissions: [],
	entitlements: [],
	sessionId: 'session-abc',
}

// Mock db for tests - these tests don't actually call db methods
const mockDb = {} as any

// Create test contract with required procedures
const testContract = {
	orgRequired: contractBuilder.input(z.object({})).output(z.object({ success: z.boolean() })),
	orgOptional: contractBuilder.input(z.object({})).output(z.object({ success: z.boolean() })),
}

// Create implementer for test contract
const testOs = implement(testContract)

// Create test procedure that requires organization (uses requireOrganization middleware)
const testOrgRequiredProcedure = testOs
	.$context<ApiContext>()
	.use(async ({ context, next, errors }) => {
		if (!context.auth) throw errors.UNAUTHORIZED()
		return next({ context: { auth: context.auth, services: context.services } })
	})
	.use(requireOrganization)
	.orgRequired.handler(() => ({ success: true }))

// Create test procedure that is org-optional (no requireOrganization middleware)
const testOrgOptionalProcedure = testOs
	.$context<ApiContext>()
	.use(async ({ context, next, errors }) => {
		if (!context.auth) throw errors.UNAUTHORIZED()
		return next({ context: { auth: context.auth!, services: context.services } })
	})
	.orgOptional.handler(() => ({ success: true }))

describe('isAuthContextWithOrg type guard', () => {
	test('returns false for undefined organizationId', () => {
		expect(isAuthContextWithOrg(mockAuthWithoutOrg)).toBe(false)
	})

	test('returns false for empty string organizationId', () => {
		expect(isAuthContextWithOrg({ ...mockAuthWithOrg, organizationId: '' })).toBe(false)
	})

	test('returns false for empty string workosOrganizationId', () => {
		expect(isAuthContextWithOrg({ ...mockAuthWithOrg, workosOrganizationId: '' })).toBe(false)
	})

	test('returns true for valid org context', () => {
		expect(isAuthContextWithOrg(mockAuthWithOrg)).toBe(true)
	})
})

describe('API Middleware - apiBase (org-required routes)', () => {
	test('throws UNAUTHORIZED when auth context is null', async () => {
		try {
			await call(
				testOrgRequiredProcedure,
				{},
				{
					context: createMockApiContext({ auth: null, services: { db: mockDb, dbReadReplica: mockDb } }),
				},
			)
			expect.unreachable('Should have thrown')
		} catch (err) {
			const error = err as any
			expect(isDefinedError(error)).toBe(true)
			expect(error.code).toBe('UNAUTHORIZED')
		}
	})

	test('throws ORGANIZATION_REQUIRED when auth has no org', async () => {
		try {
			await call(
				testOrgRequiredProcedure,
				{},
				{
					context: createMockApiContextNoOrg({
						auth: { userId: 'user-123' },
						services: { db: mockDb, dbReadReplica: mockDb },
					}),
				},
			)
			expect.unreachable('Should have thrown')
		} catch (err) {
			const error = err as any
			expect(isDefinedError(error)).toBe(true)
			expect(error.code).toBe('ORGANIZATION_REQUIRED')
		}
	})

	test('succeeds when auth has valid org context', async () => {
		const result = await call(
			testOrgRequiredProcedure,
			{},
			{
				context: createMockApiContext({
					auth: { userId: 'user-123', organizationId: 'org-456', workosOrganizationId: 'workos-org-789' },
					services: { db: mockDb, dbReadReplica: mockDb },
				}),
			},
		)
		expect(result).toEqual({ success: true })
	})
})

describe('API Middleware - apiBaseNoOrg (org-optional routes)', () => {
	test('throws UNAUTHORIZED when auth context is null', async () => {
		try {
			await call(
				testOrgOptionalProcedure,
				{},
				{
					context: createMockApiContextNoOrg({ auth: null, services: { db: mockDb, dbReadReplica: mockDb } }),
				},
			)
			expect.unreachable('Should have thrown')
		} catch (err) {
			const error = err as any
			expect(isDefinedError(error)).toBe(true)
			expect(error.code).toBe('UNAUTHORIZED')
		}
	})

	test('succeeds when auth has no org', async () => {
		const result = await call(
			testOrgOptionalProcedure,
			{},
			{
				context: createMockApiContextNoOrg({
					auth: { userId: 'user-123' },
					services: { db: mockDb, dbReadReplica: mockDb },
				}),
			},
		)
		expect(result).toEqual({ success: true })
	})

	test('succeeds when auth has valid org context', async () => {
		const result = await call(
			testOrgOptionalProcedure,
			{},
			{
				context: createMockApiContext({
					auth: { userId: 'user-123', organizationId: 'org-456', workosOrganizationId: 'workos-org-789' },
					services: { db: mockDb, dbReadReplica: mockDb },
				}),
			},
		)
		expect(result).toEqual({ success: true })
	})

	// These tests verify middleware behavior, not handler logic
})
