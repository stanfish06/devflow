import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { getAuthContext, getDaemonAuthContext } from './auth/context'
import { jwksCache } from './auth/jwks-cache'
import { db, dbReadReplica } from './db/db'
import { getLocalDirectory, registerLocalAuthRoutes } from './devflow/local-auth'
import { appRuntime } from './effects/app-runtime'
import { requireEnvironment } from './lib/environment'
import { requestBodyLimit } from './lib/request-body-limit'
import { S3Service } from './lib/s3-service'
import { logger } from './logger'
import { apiHandler, daemonApiHandler } from './orpc'
import type { Services } from './orpc/base'
import { registerGitHubSetupCallbackRoute, registerGitHubWebhookRoute } from './webhooks/github'

const app = new Hono()

// Body size limit - MUST be before other middleware to prevent OOM from large payloads
app.use('*', requestBodyLimit)

// Global error handler - catches unhandled errors before returning 500
app.onError((err, c) => {
	logger.error(err, 'Unhandled error in request')
	return c.json({ error: 'Internal Server Error' }, 500)
})

// Load the token verification keys
void jwksCache.start()

// Create service instances at startup (singletons per process)
const s3Service = new S3Service(
	requireEnvironment('S3_ARTIFACTS_BUCKET'),
	requireEnvironment('S3_ARTIFACTS_REGION', 'us-east-1'),
	process.env.S3_ARTIFACTS_ENDPOINT,
	process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
		? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
		: undefined,
)

async function getServices(): Promise<Services> {
	return {
		directory: await getLocalDirectory(),
		s3: s3Service,
		db,
		dbReadReplica,
		effectRuntime: appRuntime,
	}
}

function getRequestIp(req: Request): string | undefined {
	const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
	return forwardedFor || req.headers.get('cf-connecting-ip') || undefined
}

// Enable CORS
app.use('*', cors())

app.get('/', async (c) => {
	try {
		await db.select({ id: sessions.id }).from(sessions).limit(20)
		await db.select({ id: tasks.id }).from(tasks).limit(20)
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	} catch (err) {
		logger.error(err, 'Health check failed')
		return c.json({ status: 'unhealthy', error: String(err), timestamp: new Date().toISOString() }, 503)
	}
})

app.get('/health', async (c) => {
	try {
		await db.select({ id: sessions.id }).from(sessions).limit(20)
		await db.select({ id: tasks.id }).from(tasks).limit(20)
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	} catch (err) {
		logger.error(err, 'Health check failed')
		return c.json({ status: 'unhealthy', error: String(err), timestamp: new Date().toISOString() }, 503)
	}
})

registerLocalAuthRoutes(app)
registerGitHubSetupCallbackRoute(app, { appRuntime, logger })
registerGitHubWebhookRoute(app, { appRuntime, logger })

// mount oRPC handler
app.use('/rpc/api/v1/*', async (c, next) => {
	let authContext
	try {
		authContext = await getAuthContext(c.req.raw, appRuntime)
	} catch {
		return c.json({ error: 'Authentication unavailable' }, 503)
	}

	const { matched, response } = await apiHandler.handle(c.req.raw, {
		prefix: '/rpc/api/v1',
		context: {
			auth: authContext,
			headers: c.req.raw.headers,
			requestIp: getRequestIp(c.req.raw),
			services: await getServices(),
		},
	})

	if (matched) {
		return c.newResponse(response.body, response)
	}

	await next()
})

app.use('/rpc/daemon/v1/*', async (c, next) => {
	const authContext = await getDaemonAuthContext(c.req.raw)

	const { matched, response } = await daemonApiHandler.handle(c.req.raw, {
		prefix: '/rpc/daemon/v1',
		context: {
			auth: authContext,
			services: await getServices(),
		},
	})

	if (matched) {
		return c.newResponse(response.body, response)
	}

	await next()
})

export { app }
