import { describe, expect, test } from 'vitest'

import { DEVFLOW_SLASH_COMMANDS } from './devflow-skills'

describe('devflow slash commands', () => {
	test('includes the standalone show-me skill', () => {
		expect(DEVFLOW_SLASH_COMMANDS).toContainEqual({
			name: '/hl:show-me',
			source: 'bundled',
		})
	})

	test('includes the orchestrate skill', () => {
		expect(DEVFLOW_SLASH_COMMANDS).toContainEqual({
			name: '/hl:orchestrate',
			source: 'bundled',
		})
	})

	test('includes the teleport skill', () => {
		expect(DEVFLOW_SLASH_COMMANDS).toContainEqual({
			name: '/hl:teleport',
			source: 'bundled',
		})
	})
})
