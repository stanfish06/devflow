import {
	BetaApiOriginMacro,
	BetaAppOriginMacro,
	BetaCloudOriginMacro,
	BetaSyncOriginMacro,
	BuildVersionMacro,
	DevApiOriginMacro,
	DevAppOriginMacro,
	DevCloudOriginMacro,
	DevSyncOriginMacro,
	ProdApiOriginMacro,
	ProdAppOriginMacro,
	ProdCloudOriginMacro,
	ProdSyncOriginMacro,
} from './_macros-do-not-import' with { type: 'macro' }

export const BUILD_VERSION = BuildVersionMacro()

export interface EnvironmentConfig {
	apiOrigin: string
	syncOrigin: string
	/** Origin of the devflow-cloud web app that serves artifact and task permalinks. */
	cloudOrigin: string
	/** Origin of devflow-ui, where session deep links (`<app>/sessions/<id>`) resolve. */
	appOrigin: string
}

export type EnvironmentName = 'prod' | 'beta' | 'dev' | 'local'

const LOCAL_CONFIG: EnvironmentConfig = {
	apiOrigin: 'http://localhost:8700',
	syncOrigin: 'http://localhost:8888',
	cloudOrigin: 'http://localhost:5174',
	appOrigin: 'http://localhost:3000',
}

const DEV_API_ORIGIN = DevApiOriginMacro()
const DEV_CONFIG: EnvironmentConfig | undefined = DEV_API_ORIGIN
	? {
			apiOrigin: DEV_API_ORIGIN,
			syncOrigin: DevSyncOriginMacro() ?? 'http://localhost:8888',
			cloudOrigin: DevCloudOriginMacro() ?? 'http://localhost:5174',
			appOrigin: DevAppOriginMacro() ?? 'http://localhost:3000',
		}
	: undefined

const BETA_API_ORIGIN = BetaApiOriginMacro()
const BETA_SYNC_ORIGIN = BetaSyncOriginMacro()
const BETA_CLOUD_ORIGIN = BetaCloudOriginMacro()
const BETA_APP_ORIGIN = BetaAppOriginMacro()
const BETA_CONFIG: EnvironmentConfig | undefined =
	BETA_API_ORIGIN && BETA_SYNC_ORIGIN && BETA_CLOUD_ORIGIN && BETA_APP_ORIGIN
		? {
				apiOrigin: BETA_API_ORIGIN,
				syncOrigin: BETA_SYNC_ORIGIN,
				cloudOrigin: BETA_CLOUD_ORIGIN,
				appOrigin: BETA_APP_ORIGIN,
			}
		: undefined

const PROD_API_ORIGIN = ProdApiOriginMacro()
const PROD_SYNC_ORIGIN = ProdSyncOriginMacro()
const PROD_CLOUD_ORIGIN = ProdCloudOriginMacro()
const PROD_APP_ORIGIN = ProdAppOriginMacro()
const PROD_CONFIG: EnvironmentConfig | undefined =
	PROD_API_ORIGIN && PROD_SYNC_ORIGIN && PROD_CLOUD_ORIGIN && PROD_APP_ORIGIN
		? {
				apiOrigin: PROD_API_ORIGIN,
				syncOrigin: PROD_SYNC_ORIGIN,
				cloudOrigin: PROD_CLOUD_ORIGIN,
				appOrigin: PROD_APP_ORIGIN,
			}
		: undefined

const ENV_CONFIGS: Record<EnvironmentName, EnvironmentConfig | undefined> = {
	local: LOCAL_CONFIG,
	dev: DEV_CONFIG,
	beta: BETA_CONFIG,
	prod: PROD_CONFIG,
}

/**
 * Like {@link resolveEnvironmentConfig}, but returns undefined instead of EXITING when the env is
 * not baked into this build.
 */
export function resolveEnvironmentConfigOrNull(env: EnvironmentName): EnvironmentConfig | undefined {
	const base = ENV_CONFIGS[env]
	if (!base) return undefined

	// Local development can target an alternate stack. Named cloud environments must use their
	// baked configuration so a stale shell variable cannot mix a beta API with production links.
	if (env !== 'local') return base

	return {
		apiOrigin: process.env.DEVFLOW_API_ORIGIN ?? base.apiOrigin,
		syncOrigin: process.env.DEVFLOW_SYNC_ORIGIN ?? base.syncOrigin,
		cloudOrigin: process.env.DEVFLOW_CLOUD_ORIGIN ?? base.cloudOrigin,
		appOrigin: process.env.DEVFLOW_APP_ORIGIN || base.appOrigin,
	}
}

/**
 * Resolve the environment config for the given environment name. Runtime endpoint overrides apply
 * only to the local environment; beta and production always use their baked-in values.
 */
export function resolveEnvironmentConfig(env: EnvironmentName): EnvironmentConfig {
	const config = resolveEnvironmentConfigOrNull(env)

	if (!config) {
		if (env === 'prod') {
			console.error('The prod environment is not yet available.')
			console.error('Use --beta to connect to the beta environment.')
		} else {
			console.error(`The ${env} environment is not configured in this build.`)
		}
		process.exit(1)
	}

	return config
}
