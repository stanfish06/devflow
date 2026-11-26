import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { DEVFLOW_HOME } from './helpers'

/** The launcher's own constants (apps/launcher/src/devflow.ts): ports shift with `--port`. */
const BASE_HTTPS_PORT = 47443
const BASE_POSTGRES_PORT = 47432

type LauncherConfig = { organizationId: string; userId: string; postgresPassword: string; httpsPort?: number }

function stackDatabaseUrl(config: LauncherConfig): string {
	const port = BASE_POSTGRES_PORT + (config.httpsPort ?? BASE_HTTPS_PORT) - BASE_HTTPS_PORT
	return `postgresql://postgres:${encodeURIComponent(config.postgresPassword)}@127.0.0.1:${port}/electric`
}

export async function connectToStack(): Promise<{ config: LauncherConfig; client: pg.Client }> {
	const config = JSON.parse(readFileSync(join(DEVFLOW_HOME, 'config.json'), 'utf8')) as LauncherConfig
	const client = new pg.Client({ connectionString: stackDatabaseUrl(config) })
	await client.connect()
	return { config, client }
}
