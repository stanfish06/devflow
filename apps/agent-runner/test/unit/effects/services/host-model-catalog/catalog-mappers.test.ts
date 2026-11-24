import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test } from 'vitest'

import {
	claudeModelInfosToCatalog,
	claudeModelLabel,
} from '../../../../../src/effects/services/host-model-catalog/probe-claude-models'
import {
	type CodexAppServerModel,
	codexAppServerModelsToCatalog,
} from '../../../../../src/effects/services/host-model-catalog/probe-codex-models'

const claudeInfos: ModelInfo[] = [
	{
		value: 'default',
		resolvedModel: 'claude-opus-5[1m]',
		displayName: 'Default (recommended)',
		description: 'Opus 5 with 1M context',
		supportsEffort: true,
		supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
		supportsFastMode: true,
		supportsAutoMode: true,
	},
	{
		value: 'opus[1m]',
		resolvedModel: 'claude-opus-5[1m]',
		displayName: 'Opus (1M context)',
		description: 'Opus 5 with 1M context',
		supportsEffort: true,
		supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
		supportsFastMode: true,
		supportsAutoMode: true,
	},
	{
		value: 'haiku',
		resolvedModel: 'claude-haiku-4-5-20251001',
		displayName: 'Haiku',
		description: 'Haiku 4.5',
	},
]

describe('claudeModelInfosToCatalog', () => {
	test('drops the default alias row and marks the model it resolves to as default', () => {
		const entries = claudeModelInfosToCatalog(claudeInfos)
		expect(entries.map((entry) => entry.value)).toEqual(['opus[1m]', 'haiku'])
		expect(entries[0]).toMatchObject({
			provider: 'anthropic',
			resolvedModel: 'claude-opus-5[1m]',
			label: 'Opus 5 [1m]',
			isDefault: true,
			hidden: false,
			effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
			supportsFastMode: true,
			supportsAutoMode: true,
		})
	})

	test('a model without effort support reports no effort levels', () => {
		const haiku = claudeModelInfosToCatalog(claudeInfos)[1]
		expect(haiku).toMatchObject({
			isDefault: false,
			effortLevels: [],
			supportsFastMode: false,
			supportsAutoMode: false,
		})
	})
})

const codexModels: CodexAppServerModel[] = [
	{
		id: 'gpt-reserve',
		displayName: 'GPT-Reserve',
		hidden: true,
		supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
		serviceTiers: [{ id: 'priority' }],
	},
	{
		id: 'gpt-6-sol',
		displayName: 'GPT-6-Sol',
		hidden: false,
		defaultReasoningEffort: 'medium',
		supportedReasoningEfforts: [
			{ reasoningEffort: 'low' },
			{ reasoningEffort: 'medium' },
			{ reasoningEffort: 'ultra' },
		],
		serviceTiers: [{ id: 'priority' }],
	},
	{
		id: 'gpt-6-astra',
		displayName: 'GPT-6-Astra',
		hidden: false,
		isDefault: true,
		supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
		serviceTiers: [],
	},
]

describe('codexAppServerModelsToCatalog', () => {
	test('keeps the CLI order and marks the row the CLI calls default', () => {
		const entries = codexAppServerModelsToCatalog(codexModels)
		expect(entries.map((entry) => entry.value)).toEqual(['gpt-reserve', 'gpt-6-sol', 'gpt-6-astra'])
		expect(entries.map((entry) => entry.isDefault)).toEqual([false, false, true])
	})

	test('without a CLI default, the first visible row is the default', () => {
		const entries = codexAppServerModelsToCatalog(codexModels.map(({ isDefault: _, ...model }) => model))
		expect(entries.map((entry) => entry.isDefault)).toEqual([false, true, false])
	})

	test('derives capability flags from the model row', () => {
		const [reserve, sol, astra] = codexAppServerModelsToCatalog(codexModels)
		expect(sol).toMatchObject({
			provider: 'codex',
			label: 'GPT-6-Sol',
			hidden: false,
			effortLevels: ['low', 'medium', 'ultra'],
			defaultEffort: 'medium',
			supportsFastMode: true,
			supportsAutoMode: false,
		})
		expect(astra).toMatchObject({ supportsFastMode: false })
		expect(reserve).toMatchObject({ hidden: true })
	})
})

describe('catalog rows are always publishable', () => {
	test('an empty Codex display name falls back to the id and empty efforts are dropped', () => {
		const [entry] = codexAppServerModelsToCatalog([
			{
				id: 'gpt-blank',
				displayName: '',
				defaultReasoningEffort: '',
				supportedReasoningEfforts: [{ reasoningEffort: '' }, { reasoningEffort: 'low' }],
			},
		])
		expect(entry).toMatchObject({ label: 'gpt-blank', effortLevels: ['low'], defaultEffort: undefined })
	})

	test('a Codex default effort the model does not list is dropped', () => {
		const [entry] = codexAppServerModelsToCatalog([
			{
				id: 'gpt-x',
				defaultReasoningEffort: 'ultra',
				supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
			},
		])
		expect(entry?.defaultEffort).toBeUndefined()
	})

	test('an empty Claude display name falls back to the value', () => {
		const [entry] = claudeModelInfosToCatalog([
			{
				value: 'opus',
				displayName: '   ',
				description: '',
				supportsEffort: true,
				supportedEffortLevels: ['low'],
			},
		])
		expect(entry).toMatchObject({ label: 'opus', effortLevels: ['low'] })
	})
})

describe('claudeModelLabel', () => {
	test('shows the version an alias runs today, taken from the description', () => {
		expect(
			claudeModelLabel({
				value: 'opus',
				displayName: 'Opus',
				description: 'Opus 5.5 · Best for everyday, complex tasks',
			}),
		).toBe('Opus 5.5')
		expect(
			claudeModelLabel({
				value: 'opus[1m]',
				displayName: 'Opus (1M context)',
				description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
			}),
		).toBe('Opus 5.5 [1m]')
	})

	test('keeps a display name that already carries a version, and falls back to the value', () => {
		expect(claudeModelLabel({ value: 'x', displayName: 'Fable 5.1', description: 'anything' })).toBe('Fable 5.1')
		expect(claudeModelLabel({ value: 'sonnet', displayName: 'Sonnet', description: 'Fast' })).toBe('Sonnet')
		expect(claudeModelLabel({ value: 'haiku', displayName: '', description: '' })).toBe('haiku')
	})
})
