import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import {
	claudeCodeSubscriptionModel,
	isClaudeCodeSubscriptionEnabled,
} from '@devflow/ai/providers/claude-code-subscription'
import { createReliableLanguageModel } from '@devflow/ai/reliable-language-model'

import { logger } from '../logger'

type AppModelAlias = 'haiku' | 'sonnet'

const PRIMARY: Record<AppModelAlias, LanguageModelV3> = {
	haiku: anthropic('claude-haiku-4-5'),
	sonnet: anthropic('claude-sonnet-5'),
}

const SECONDARY: Record<AppModelAlias, LanguageModelV3> = {
	haiku: openai('gpt-5-mini'),
	sonnet: openai('gpt-5'),
}

export function createAppReliableLanguageModel(alias: AppModelAlias): LanguageModelV3 {
	// Run helper models through the Claude Code CLI's subscription login.
	if (isClaudeCodeSubscriptionEnabled()) return claudeCodeSubscriptionModel(alias)
	return createReliableLanguageModel({
		primary: PRIMARY[alias],
		secondary: SECONDARY[alias],
		onAnyError: (error) => {
			logger.warn(
				{
					alias,
					error_message: error instanceof Error ? error.message : String(error),
				},
				'AI language model call failed; retrying reliable model path',
			)
		},
		onFailure: (error) => {
			logger.error(error, {
				tags: {
					error_type: 'ai_fallback_exhausted',
					model_alias: alias,
				},
				extra: {
					fallback_provider: 'openai',
					primary_provider: 'anthropic',
				},
			})
		},
	})
}
