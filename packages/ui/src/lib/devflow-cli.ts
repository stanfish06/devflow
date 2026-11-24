const DEVFLOW_CLI_TARGETS = {
	local: {
		packageSpecifier: '@devflow/cli@dev',
		environmentFlag: '--local',
	},
	dev: {
		packageSpecifier: '@devflow/cli@dev',
		environmentFlag: '--dev',
	},
	beta: {
		packageSpecifier: '@devflow/cli@beta',
		environmentFlag: '--beta',
	},
	prod: {
		packageSpecifier: '@devflow/cli@latest',
		environmentFlag: null,
	},
} as const

export type CliStage = keyof typeof DEVFLOW_CLI_TARGETS

export function isCliStage(value: unknown): value is CliStage {
	return typeof value === 'string' && Object.hasOwn(DEVFLOW_CLI_TARGETS, value)
}

export function getCliTarget(stage: CliStage) {
	return DEVFLOW_CLI_TARGETS[stage]
}

export function getCliInstallCommand(stage: CliStage): string {
	return `npm install -g ${getCliTarget(stage).packageSpecifier}`
}

export function getCliNpxCommand(stage: CliStage, args: string): string {
	return `npx ${getCliTarget(stage).packageSpecifier} ${args}`
}
