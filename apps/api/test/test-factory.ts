/**
 * Test-mode app factory for the API.
 *
 * Creates a Hono app with the same oRPC handler mounting as app.ts but accepts
 * injected dependencies instead of module-level singletons. No side effects:
 * no `jwksCache.start()`, no env var reads.
 *
 * Used by API tests that spin up a headless server with injected dependencies
 * such as the database, user directory, API auth, and daemon auth.
 */

import { serve } from '@hono/node-server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { getAuthContext } from '../src/auth/context'
import type { UserDirectory } from '../src/auth/directory'
import type { AuthContextOptionalOrg } from '../src/auth/jwt-validator'
import type { AppRuntime } from '../src/effects/app-runtime'
import type { IS3Service } from '../src/lib/s3-service'
import { apiHandler, daemonApiHandler } from '../src/orpc'
import type { ApiContext, DaemonAuthContext, DaemonContext, Services } from '../src/orpc/base'
import { createMockServices } from './mocks/auth-context.mock'
import { createRuntimeWithTestPostgresLayer, directoryLayer } from './utils/effect-procedure-test-runtime'

export type { AuthContextOptionalOrg } from '../src/auth/jwt-validator'

/** No-op S3 service for tests that don't need real presigned URLs */
const noopS3: IS3Service = {
	getPresignedUploadUrl: async () => 'https://test-upload-url',
	getPresignedDownloadUrl: async () => 'https://test-download-url',
}

export type TestAppConfig = {
	/** Database client for all oRPC handlers */
	db: PostgresJsDatabase
	/** Optional read replica — falls back to db if not provided */
	dbReadReplica?: PostgresJsDatabase
	/** User directory for auth and member lookups */
	directory: UserDirectory
	/** S3 service — defaults to no-op mock */
	s3?: IS3Service
	/** App Effect runtime seam — defaults to the canonical test runtime mock */
	effectRuntime?: AppRuntime
	/**
	 * Test API auth context — if provided, bypasses JWT validation for all
	 * /rpc/api/v1/* requests. Same bypass pattern as electric proxy testAuthContext.
	 */
	testApiAuth?: AuthContextOptionalOrg
	/**
	 * Test daemon auth context — if provided, bypasses token validation for all
	 * /rpc/daemon/v1/* requests.
	 */
	testDaemonAuth?: DaemonAuthContext
}

export type TestServicesConfig = Pick<TestAppConfig, 'db' | 'dbReadReplica' | 'directory' | 's3' | 'effectRuntime'>

/**
 * Build the `Services` bag for the headless test app.
 *
 * Layers on top of `createMockServices` (the single canonical default list) and
 * overrides only `s3` (a bootable no-op) plus the caller-supplied `directory` and `db`.
 */
export function createTestServices(config: TestServicesConfig): Services {
	const dbReadReplica = config.dbReadReplica ?? config.db
	const effectRuntime =
		config.effectRuntime ??
		createRuntimeWithTestPostgresLayer(config.db, { directory: directoryLayer(config.directory) })

	return createMockServices({
		directory: config.directory,
		db: config.db,
		dbReadReplica,
		s3: config.s3 ?? noopS3,
		effectRuntime,
	})
}

function getRequestIp(req: Request): string | undefined {
	return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined
}

export function createTestApiContext(input: {
	auth?: AuthContextOptionalOrg | null
	services: Services
	request?: Request
}): ApiContext {
	return {
		auth: input.auth ?? null,
		headers: input.request?.headers,
		requestIp: input.request ? getRequestIp(input.request) : undefined,
		services: input.services,
	}
}

export function createTestDaemonContext(input: { auth?: DaemonAuthContext | null; services: Services }): DaemonContext {
	return {
		auth: input.auth ?? null,
		services: input.services,
	}
}

/**
 * Create a headless Hono app that mounts the oRPC handlers at the same paths
 * as the production app.ts, but with injected dependencies.
 */
export function createApp(config: TestAppConfig): Hono {
	const services = createTestServices(config)

	const app = new Hono()

	// Enable CORS (same as production)
	app.use('*', cors())

	// Mount API oRPC handler
	app.use('/rpc/api/v1/*', async (c, next) => {
		let auth: AuthContextOptionalOrg | null
		if (config.testApiAuth !== undefined) {
			auth = config.testApiAuth
		} else {
			try {
				auth = await getAuthContext(c.req.raw, services.effectRuntime)
			} catch {
				return c.json({ error: 'Authentication unavailable' }, 503)
			}
		}

		const { matched, response } = await apiHandler.handle(c.req.raw, {
			prefix: '/rpc/api/v1',
			context: createTestApiContext({ auth, services, request: c.req.raw }),
		})

		if (matched) {
			return c.newResponse(response.body, response)
		}

		await next()
	})

	// Mount daemon oRPC handler
	app.use('/rpc/daemon/v1/*', async (c, next) => {
		const { matched, response } = await daemonApiHandler.handle(c.req.raw, {
			prefix: '/rpc/daemon/v1',
			context: createTestDaemonContext({ auth: config.testDaemonAuth, services }),
		})

		if (matched) {
			return c.newResponse(response.body, response)
		}

		await next()
	})

	return app
}

/**
 * Start a Hono app using Node's HTTP server. Port 0 lets the OS assign a free port.
 * Returns a Bun.serve-compatible subset — call .stop() to shut down.
 */
export function startServer(app: Hono, port = 0) {
	const server = serve({ fetch: app.fetch, port })
	const address = server.address()
	const assignedPort = typeof address === 'object' && address !== null ? address.port : port

	return {
		port: assignedPort,
		stop: (_force?: boolean) => {
			;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
			server.close()
		},
	}
}
