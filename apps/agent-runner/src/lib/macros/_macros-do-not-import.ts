/**
 * IMPORATNT: This file contains bun macros. These are exported, and imported and re-exported through index.ts as macros
 * This means that they will be evaluated at build time, NEVER at runtime.
 *
 * This file should NEVER EVER be imported directly by anything other than ./index.ts to ensure that the with {type: macro} is always captured
 *
 * Learn more HERE: https://bun.com/docs/bundler/macros
 *
 * There are several axes of configuration:
 * 1. build TYPE: this would be local, dev, beta, prod, or experimental
 * 2. build VERSION: this would be like 0.16.5
 * 3. NODE_ENV: set at compile time - can later be superceded at r
 */

const BUILD_TYPES = ['local', 'dev', 'beta', 'prod', 'experimental', 'stable'] as const
export type BuildType = (typeof BUILD_TYPES)[number]

const NODE_ENVS = ['production', 'development'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

function requireEnvironment(key: string): string | undefined {
	return process.env[key]
}

function requireEnvironmentWithDefault(key: string, defaultValue: string): string {
	return process.env[key] ?? defaultValue
}

/**
 * Returns the NODE_ENV set at build-time
 * @returns
 */
export function NodeEnvMacro(): NodeEnv | undefined {
	let nodeEnv = requireEnvironment('NODE_ENV')
	if (!NODE_ENVS.includes(nodeEnv as NodeEnv)) nodeEnv = undefined
	return nodeEnv as NodeEnv | undefined
}

/**
 * Returns the BUILD_TYPE set at build-time; defaults to `experimental` if not set
 * @returns
 */
export function BuildTypeMacro() {
	return requireEnvironment('BUILD_TYPE')
}

export function BuildVersionMacro() {
	return requireEnvironmentWithDefault('BUILD_VERSION', 'dev')
}

export function LogLevelMacro() {
	return requireEnvironmentWithDefault('LOG_LEVEL', NodeEnvMacro() === 'production' ? 'info' : 'debug')
}

export function LogBaseMacro() {
	return requireEnvironmentWithDefault('LOG_BASE', '~/.devflow/logs')
}

export function ApiOriginMacro() {
	return requireEnvironment('DEVFLOW_DAEMON_API_ORIGIN')
}

export function SyncOriginMacro() {
	return requireEnvironment('DEVFLOW_DAEMON_SYNC_ORIGIN')
}

export function CloudOriginMacro() {
	return requireEnvironment('DEVFLOW_DAEMON_CLOUD_ORIGIN')
}

export function AppOriginMacro() {
	return requireEnvironment('DEVFLOW_DAEMON_APP_ORIGIN')
}
