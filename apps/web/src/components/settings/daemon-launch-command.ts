import { getCliInstallCommand, getCliTarget, isCliStage, type CliStage } from '@devflow/ui/lib/devflow-cli'

const REMOTE_DAEMON_BUILD_TYPE_FALLBACK = 'prod'

export function resolveDaemonLaunchBuildType({
	remoteDaemonBuildType,
	uiBuildType,
}: {
	remoteDaemonBuildType?: string
	uiBuildType?: string
}): CliStage {
	if (isCliStage(remoteDaemonBuildType)) return remoteDaemonBuildType
	if (isCliStage(uiBuildType)) return uiBuildType
	return REMOTE_DAEMON_BUILD_TYPE_FALLBACK
}

export function buildDaemonLaunchCommand({
	remoteDaemonBuildType,
	token,
	uiBuildType,
}: {
	remoteDaemonBuildType?: string
	token: string
	uiBuildType?: string
}): string {
	const daemonBuildType = resolveDaemonLaunchBuildType({ remoteDaemonBuildType, uiBuildType })
	const isLocal = daemonBuildType === 'local'
	const target = getCliTarget(daemonBuildType)
	const executable = isLocal ? 'bun apps/cli/src/index.ts' : `npx ${target.packageSpecifier}`
	const commandParts = [executable, 'daemon', 'launch']

	if (target.environmentFlag) commandParts.push(target.environmentFlag)
	commandParts.push('--launch-token', token)

	const launchCommand = commandParts.join(' ')

	return isLocal ? launchCommand : `${getCliInstallCommand(daemonBuildType)} && ${launchCommand}`
}
