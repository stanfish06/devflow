import { describe, expect, test } from 'vitest'

import {
	getCliInstallCommand,
	getCliNpxCommand,
	getCliTarget,
	isCliStage,
} from './devflow-cli'

describe('devflow CLI targets', () => {
	test.each([
		['prod', '@devflow/cli@latest', null],
		['beta', '@devflow/cli@beta', '--beta'],
		['dev', '@devflow/cli@dev', '--dev'],
		['local', '@devflow/cli@dev', '--local'],
	] as const)('maps %s to its package and environment flag', (stage, packageSpecifier, flag) => {
		expect(getCliTarget(stage)).toEqual({ packageSpecifier, environmentFlag: flag })
	})

	test('builds install and npx commands from the shared package mapping', () => {
		expect(getCliInstallCommand('beta')).toBe('npm install -g @devflow/cli@beta')
		expect(getCliNpxCommand('dev', 'agents auth')).toBe('npx @devflow/cli@dev agents auth')
	})

	test('recognizes only supported stages', () => {
		expect(isCliStage('prod')).toBe(true)
		expect(isCliStage('preview')).toBe(false)
		expect(isCliStage(undefined)).toBe(false)
	})
})
