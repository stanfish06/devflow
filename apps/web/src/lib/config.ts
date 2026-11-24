import { Option, Schema } from 'effect'

import { logger } from '@/lib/logger'

import { BUILD_TYPES, BuildType } from './build-types'

logger.info(
	'BUILD TYPE:',
	import.meta.env.VITE_PUBLIC_BUILD_TYPE ?? '(Falling back to local due to missing VITE_PUBLIC_BUILD_TYPE',
)

const configuredBuildType = import.meta.env.VITE_PUBLIC_BUILD_TYPE || 'local'
const buildType = Option.getOrUndefined(Schema.decodeUnknownOption(BuildType)(configuredBuildType)) ?? 'local'

const CHANNEL_NAMES: Record<(typeof BUILD_TYPES)[number], string> = {
	local: 'Local',
	dev: 'Dev',
	beta: 'Beta',
	prod: 'Prod',
}

export const buildConfig = {
	// Get the build type, defaulting to 'local' if not set
	type: buildType,

	version: import.meta.env.VITE_PUBLIC_BUILD_VERSION ?? 'dev',

	daemonVersion: import.meta.env.VITE_PUBLIC_DAEMON_VERSION ?? 'dev',

	// Channel name for display
	channelName: CHANNEL_NAMES[buildType],

	devstackId: import.meta.env.VITE_PUBLIC_DEVSTACK_ID || null,
}

export function buildDisplayLabel(
	config: Pick<typeof buildConfig, 'channelName' | 'devstackId'> = buildConfig,
): string {
	return config.devstackId ? `devstk-${config.devstackId}` : config.channelName
}
