import {
	ApiOriginMacro,
	AppOriginMacro,
	BuildTypeMacro,
	BuildVersionMacro,
	CloudOriginMacro,
	LogBaseMacro,
	LogLevelMacro,
	NodeEnvMacro,
	SyncOriginMacro,
} from './_macros-do-not-import' with { type: 'macro' }

export const BUILD_TYPE = BuildTypeMacro()
export const BUILD_VERSION = BuildVersionMacro()
export const LOG_LEVEL = LogLevelMacro()
export const LOG_BASE = LogBaseMacro()

export const BUILD_NODE_ENV = NodeEnvMacro()

export const API_ORIGIN = process.env.DEVFLOW_API_ORIGIN ?? ApiOriginMacro()

export const SYNC_ORIGIN = process.env.DEVFLOW_SYNC_ORIGIN ?? SyncOriginMacro()

// The standalone daemon uses its build-time origin. The shared CLI overrides this before loading
// the embedded daemon so `devflow --beta daemon launch` produces beta artifact links.
export const CLOUD_ORIGIN = process.env.DEVFLOW_CLOUD_ORIGIN || CloudOriginMacro()

/**
 * devflow-ui's origin, where session deep links (`<app>/sessions/<id>`) resolve. An empty override
 * counts as unset — `DEVFLOW_APP_ORIGIN=` in a shell rc must not blank out the baked value.
 */
export const APP_ORIGIN = process.env.DEVFLOW_APP_ORIGIN || AppOriginMacro()
