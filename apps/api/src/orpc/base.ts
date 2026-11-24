import { ApiContract, DaemonApiContract } from '@devflow/api-contract/contract-router'
import { implement, ORPCError } from '@orpc/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import z from 'zod/v4'

import type { DaemonAuthContext } from '../auth/context'
import type { UserDirectory } from '../auth/directory'
import type { AuthContext, AuthContextOptionalOrg } from '../auth/jwt-validator'
import type { AppRuntime } from '../effects/app-runtime'
import { sharesMetricsWithMembers } from '../effects/services/metrics/metrics-audience'
import type { IS3Service } from '../lib/s3-service'
import { logger } from '../logger'

/**
 * Injectable services available in context.
 */
export type Services = {
	directory: UserDirectory
	s3: IS3Service
	db: PostgresJsDatabase
	dbReadReplica: PostgresJsDatabase
	/** App-wide Effect runtime, shared by API and daemon contexts, for classic procedures that run Effect work. */
	effectRuntime: AppRuntime
}

/**
 * Full API context including auth and injectable services.
 */
export type ApiContext = {
	auth: AuthContextOptionalOrg | null
	services: Services
	headers?: Headers | Record<string, string | undefined>
	requestIp?: string
}

export const os = implement(ApiContract).$context<ApiContext>()

/** Log genuine server faults; declared oRPC errors and any 4xx are client/business outcomes. */
function captureUnexpected(error: unknown, path?: readonly string[]): void {
	if (error instanceof ORPCError && (error.defined || error.status < 500)) return
	logger.error(error, { operation: path?.join('.') }, 'Unexpected procedure error')
}

/**
 * Type guard to verify auth context has valid organization
 * Returns true if organizationId and workosOrganizationId are non-empty strings
 */
export function isAuthContextWithOrg(auth: AuthContextOptionalOrg | null): auth is AuthContext {
	if (!auth) return false
	return (
		typeof auth.organizationId === 'string' &&
		auth.organizationId.length > 0 &&
		typeof auth.workosOrganizationId === 'string' &&
		auth.workosOrganizationId.length > 0
	)
}

/**
 * Reusable middleware that requires organization context
 * Throws ORGANIZATION_REQUIRED if org is missing, narrows type to AuthContext
 */
export const requireOrganization = os.middleware(async ({ context, next, errors }) => {
	if (!isAuthContextWithOrg(context.auth)) {
		throw errors.ORGANIZATION_REQUIRED({
			data: { message: 'Please select an organization to continue' },
		})
	}
	// TypeScript knows auth is AuthContext after type guard
	return next({ context: { auth: context.auth, services: context.services } })
})

/**
 * Api base with auth and error capture
 * Now uses requireOrganization middleware - but JWT still validates org, so no behavior change
 */
export const apiBaseOrgRequired = os
	// First: Check auth exists, narrow from null
	.use(async ({ context, next, errors }) => {
		if (!context.auth) throw errors.UNAUTHORIZED()
		return next({ context: { auth: context.auth, services: context.services } })
	})
	// Second: Require organization, narrow to AuthContext
	.use(requireOrganization)
	// Third: log unexpected errors
	.use(async ({ context, next, path }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error, path)
			throw error
		}
	})

/**
 * Api base for org-optional routes (auth required, org optional)
 * Use this for bootstrap routes like organizations.list
 */
export const apiBaseNoOrg = os
	.use(async ({ context, next, errors }) => {
		const auth = context.auth
		if (!auth) throw errors.UNAUTHORIZED()

		return next({
			context: { auth, services: context.services },
		})
	})
	// Log unexpected errors
	.use(async ({ context, next, path }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error, path)
			throw error
		}
	})

export const apiBasePublic = os.use(async ({ context, next, path }) => {
	try {
		return await next({ context })
	} catch (error) {
		captureUnexpected(error, path)
		throw error
	}
})

/**
 * Middleware that requires admin role.
 * Checks both singular role and plural roles for compatibility.
 */
export const requireAdmin = os.middleware(async ({ context, next, errors }) => {
	const auth = context.auth
	if (!auth) throw errors.UNAUTHORIZED()
	const isAdmin = auth.role === 'admin' || auth.roles?.includes('admin')
	if (!isAdmin) {
		throw errors.FORBIDDEN()
	}
	return next({ context })
})

/** Api base for sync v2 endpoints: auth + requireOrg + error logging. */
export const apiBaseSyncV2 = os
	// First: Check auth exists, narrow from null
	.use(async ({ context, next, errors }) => {
		if (!context.auth) throw errors.UNAUTHORIZED()
		return next({ context: { auth: context.auth, services: context.services } })
	})
	// Second: Require organization, narrow to AuthContext
	.use(requireOrganization)
	// Third: log unexpected errors
	.use(async ({ context, next }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error)
			throw error
		}
	})

export function isOrganizationAdmin(auth: Pick<AuthContext, 'role' | 'roles'>): boolean {
	return auth.role === 'admin' || (auth.roles?.includes('admin') ?? false)
}

/**
 * Api base for organization admin routes: auth + requireOrg + requireAdmin + error logging
 */
export const apiBaseForOrganizationAdmin = os
	// First: Check auth exists
	.use(async ({ context, next, errors }) => {
		if (!context.auth) throw errors.UNAUTHORIZED()
		return next({ context: { auth: context.auth, services: context.services } })
	})
	// Second: Require organization
	.use(requireOrganization)
	// Third: Require admin role
	.use(async ({ context, next, errors }) => {
		if (!isOrganizationAdmin(context.auth)) {
			throw errors.FORBIDDEN()
		}
		return next({ context })
	})
	// Fourth: log unexpected errors
	.use(async ({ context, next }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error)
			throw error
		}
	})

/**
 * Org base + the Advanced Metrics audience gate: admins always, other members only where an admin has
 * opened the page to the whole org. Every metrics endpoint that exposes per-member cost/output
 * aggregates derives from this base so no endpoint can skip the check.
 */
export const apiBaseForAdvancedMetrics = apiBaseOrgRequired.use(async ({ context, next, errors }) => {
	const shares = await sharesMetricsWithMembers(context.services.effectRuntime, {
		organizationId: context.auth.organizationId,
		isAdmin: isOrganizationAdmin(context.auth),
	})
	if (!shares) throw errors.FORBIDDEN()
	return next({ context })
})

export type LaunchTokenContext = {
	launchTokenAuth: { userId: string; organizationId: string }
	services: Services
}

const LaunchTokenEnvelope = z.object({ launchToken: z.string() }).passthrough()

/**
 * Api base for launch-token-authenticated routes.
 * Does NOT check context.auth (which is null — these requests carry no user JWT).
 * Instead validates the launch token from the input body.
 */
export const apiBaseLaunchToken = os
	.use(
		os.middleware(async ({ context, next, errors }, input) => {
			const { validateLaunchToken } = await import('../auth/daemon-tokens')
			const parsedInput = LaunchTokenEnvelope.safeParse(input)
			if (!parsedInput.success) {
				throw errors.UNAUTHORIZED()
			}
			const claims = await validateLaunchToken(parsedInput.data.launchToken)
			if (!claims) throw errors.UNAUTHORIZED()
			return next({
				context: {
					launchTokenAuth: { userId: claims.userId, organizationId: claims.organizationId },
					services: context.services,
				},
			})
		}),
	)
	.use(async ({ context, next }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error)
			throw error
		}
	})

export type { DaemonAuthContext } from '../auth/context'

/**
 * Daemon context including auth and injectable services.
 */
export type DaemonContext = {
	auth: DaemonAuthContext | null
	services: Services
}

const daemonOs = implement(DaemonApiContract).$context<DaemonContext>()

export const daemonBase = daemonOs
	.use(async ({ context, next, errors }) => {
		const auth = context.auth
		if (!auth) throw errors.UNAUTHORIZED()

		return next({
			context: { auth, services: context.services },
		})
	})
	// Log unexpected errors
	.use(async ({ context, next, path }) => {
		try {
			return await next({ context })
		} catch (error) {
			captureUnexpected(error, path)
			throw error
		}
	})
