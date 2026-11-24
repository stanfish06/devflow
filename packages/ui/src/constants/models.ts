import type { CodingAgent } from '@devflow/schemas/coding-agent'
import type { HostModelCatalogProvider } from '@devflow/schemas/zod/model-catalog'

import type { ProviderOption } from './providers'

/** Grok ids that saved settings may still hold. devflow runs no xAI agent, so no picker lists them. */
const LEGACY_XAI_MODEL_IDS = ['grok-4.5', 'grok-4.6'] as const
export type XaiModelOption = (typeof LEGACY_XAI_MODEL_IDS)[number]
export const DEFAULT_XAI_MODEL_ID: XaiModelOption = 'grok-4.6'

export const MODEL_OPTIONS = [
	// Anthropic models - latest
	{ value: 'fable' as const, label: 'FABLE', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-fable-5-1' as const, label: 'FABLE 5.1', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-fable-5' as const, label: 'FABLE 5', provider: 'anthropic' as ProviderOption },
	// Anthropic models - shorthand aliases (always latest)
	{ value: 'opus' as const, label: 'OPUS', provider: 'anthropic' as ProviderOption },
	// Anthropic models - specific versions
	{ value: 'claude-opus-5-5' as const, label: 'Opus 5.5', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-5' as const, label: 'OPUS 5', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-4-8' as const, label: 'OPUS 4.8', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-4-7' as const, label: 'OPUS 4.7', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-4-6' as const, label: 'OPUS 4.6', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-4-6-1m' as const, label: 'OPUS 4.6 1M', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-opus-4-5' as const, label: 'OPUS 4.5', provider: 'anthropic' as ProviderOption },
	{ value: 'sonnet' as const, label: 'SONNET', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-sonnet-5-5' as const, label: 'Sonnet 5.5', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-sonnet-5' as const, label: 'SONNET 5', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-sonnet-4-6' as const, label: 'SONNET 4.6', provider: 'anthropic' as ProviderOption },
	{ value: 'haiku' as const, label: 'HAIKU', provider: 'anthropic' as ProviderOption },
	{ value: 'claude-haiku-4-5-20251001' as const, label: 'HAIKU 4.5', provider: 'anthropic' as ProviderOption },
	// Codex models
	{ value: 'gpt-6.1-sol' as const, label: 'GPT-6.1 Sol', provider: 'codex' as ProviderOption },
	{ value: 'gpt-6-astra' as const, label: 'GPT-6 Astra', provider: 'codex' as ProviderOption },
	{ value: 'gpt-6-sol' as const, label: 'GPT-6 Sol', provider: 'codex' as ProviderOption },
	{ value: 'gpt-6-luna' as const, label: 'GPT-6 Luna', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.6-sol' as const, label: 'GPT-5.6 Sol', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.6-terra' as const, label: 'GPT-5.6 Terra', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.6-luna' as const, label: 'GPT-5.6 Luna', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.5' as const, label: 'GPT-5.5', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.4' as const, label: 'GPT-5.4', provider: 'codex' as ProviderOption },
	{ value: 'gpt-5.4-mini' as const, label: 'GPT-5.4 Mini', provider: 'codex' as ProviderOption },
] as const

export type KnownModelOption = (typeof MODEL_OPTIONS)[number]['value']
/** A model id the picker can hold: a bundled one, or any id a host's runtime catalog reports. */
export type ModelOption = KnownModelOption | (string & {})

export interface ModelPickerOption {
	readonly value: ModelOption
	readonly label: string
	readonly provider: ProviderOption
}

export function findModelOption(model: string) {
	return MODEL_OPTIONS.find((option) => option.value === model)
}

export function findXaiModelOption(model: string): XaiModelOption | undefined {
	return LEGACY_XAI_MODEL_IDS.find((modelId) => modelId === model)
}

export function catalogProviderFor({
	agent,
	provider,
}: {
	agent?: CodingAgent | null
	provider?: ProviderOption | null
}): HostModelCatalogProvider | null {
	// Claude Code runs the installed CLI, whose ids ('opus[1m]', 'sonnet') are CLI syntax; Codex runs
	// the Codex CLI's app-server. No other agent/provider pair has a host catalog.
	if (agent === 'claude') return 'anthropic'
	if ((agent === 'codelayer' || agent === 'fold') && provider === 'codex') return 'codex'
	return null
}

export function getModelOptionsForAgentProvider({
	agent,
	provider,
}: {
	agent?: CodingAgent | null
	provider?: ProviderOption | null
}): ReadonlyArray<ModelPickerOption> {
	if (agent === 'claude') {
		return MODEL_OPTIONS.filter((option) => option.provider === 'anthropic')
	}

	if (provider) {
		return MODEL_OPTIONS.filter((option) => option.provider === provider)
	}

	return MODEL_OPTIONS.filter((option) => option.provider === 'anthropic')
}

export function modelLabel(model: string, options?: ReadonlyArray<{ readonly value: string; readonly label: string }>): string {
	return options?.find((option) => option.value === model)?.label ?? findModelOption(model)?.label ?? model
}
