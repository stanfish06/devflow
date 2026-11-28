import { describe, expect, test } from 'vitest'

import { getWorkflowPhases, toWorkflowSessions } from './workflow-phases'

describe('getWorkflowPhases', () => {
	test('rpi returns 7 phases including PR', () => {
		const phases = getWorkflowPhases('rpi', 'never')

		expect(phases.map((phase) => phase.name)).toEqual([
			'rpi:research-questions',
			'rpi:research',
			'rpi:design',
			'rpi:structure',
			'rpi:plan',
			'rpi:implementation',
			'rpi:describe-pr',
		])
	})

	test('outline_only returns 6 phases with no plan phase and PR', () => {
		const phases = getWorkflowPhases('outline_only', 'never')

		expect(phases).toHaveLength(6)
		expect(phases.map((phase) => phase.name)).toEqual([
			'rpi:research-questions',
			'rpi:research',
			'rpi:design',
			'rpi:structure',
			'rpi:implementation',
			'rpi:describe-pr',
		])
		expect(phases.some((phase) => phase.name === 'rpi:plan')).toBe(false)
	})

	test('prd_tdd returns 7 phases with PRD, TDD, and PR phases', () => {
		const phases = getWorkflowPhases('prd_tdd', 'never')

		expect(phases.map((phase) => phase.title)).toEqual([
			'questions',
			'research',
			'PRD',
			'TDD',
			'outline',
			'implement',
			'PR',
		])
		expect(phases.map((phase) => phase.name)).toContain('rpi:design-prd')
		expect(phases.map((phase) => phase.name)).toContain('rpi:design-tdd')
	})

	test('oneshot has no phases, with or without a deferred worktree', () => {
		expect(getWorkflowPhases('oneshot', null)).toEqual([])
		expect(getWorkflowPhases('oneshot', 'later')).toEqual([])
	})

	test('timing=now prepends synthetic worktree phase', () => {
		const phases = getWorkflowPhases('outline_only', 'now')

		expect(phases[0]).toEqual({ name: 'worktree-setup', title: 'worktree', synthetic: true })
		expect(phases[1]?.name).toBe('rpi:research-questions')
	})

	test('timing=later inserts worktree before implement', () => {
		const phases = getWorkflowPhases('outline_only', 'later')

		expect(phases.map((phase) => phase.name)).toEqual([
			'rpi:research-questions',
			'rpi:research',
			'rpi:design',
			'rpi:structure',
			'rpi:worktree-setup',
			'rpi:implementation',
			'rpi:describe-pr',
		])
		expect(phases.find((phase) => phase.name === 'rpi:worktree-setup')?.synthetic).toBeUndefined()
	})

	test('null timing behaves like later', () => {
		const phases = getWorkflowPhases('outline_only', null)

		expect(phases.map((phase) => phase.name)).toContain('rpi:worktree-setup')
		expect(phases.find((phase) => phase.name === 'rpi:worktree-setup')?.synthetic).toBeUndefined()
	})

	test('timing=never has no worktree phase', () => {
		const phases = getWorkflowPhases('rpi', 'never')

		expect(phases.some((phase) => phase.name.includes('worktree'))).toBe(false)
	})

	test.each(['now', 'later', 'never'] as const)('freeform has no graph phases for timing=%s', (timing) => {
		expect(getWorkflowPhases('oneshot', timing)).toEqual([])
	})

	test('null workflowType returns empty array', () => {
		expect(getWorkflowPhases(null, 'later')).toEqual([])
	})
})

describe('toWorkflowSessions', () => {
	const phases = getWorkflowPhases('prd_tdd', 'never')
	const session = (id: string, names: string[], last_activity_at: bigint, archived = false) => ({
		id,
		title: id,
		status: 'ready_for_input' as const,
		archived,
		last_activity_at,
		labels: names.map((name) => ({ name, title: name })),
	})

	test('shows archive history and marks the most recently active session in a configured phase', () => {
		const rows = [
			session('tdd', ['rpi:design-tdd'], 1n),
			session('prd', ['rpi:design', 'team:alpha', 'rpi:research', 'rpi:design-prd'], 2n),
			session('unlabeled', [], 3n),
			session('archived', ['rpi:implementation'], 4n, true),
		]
		expect(toWorkflowSessions(rows, phases).map((node) => [node.id, node.labelTitle, node.isCurrentStage])).toEqual(
			[
				['tdd', 'TDD', false],
				['prd', 'PRD', true],
				['archived', 'implement', false],
			],
		)
		expect(toWorkflowSessions(rows, [])).toEqual([])
	})

	test('same-timestamp iterations select the same node regardless of source order', () => {
		const rows = [session('1', ['rpi:design-tdd'], 10n), session('2', ['rpi:design-tdd'], 10n)]
		expect(toWorkflowSessions(rows, phases).find((node) => node.isCurrentStage)?.id).toBe('2')
		expect(toWorkflowSessions(rows.reverse(), phases).find((node) => node.isCurrentStage)?.id).toBe('2')
	})
})
