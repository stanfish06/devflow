/**
 * devflow: run the API's helper model calls (session titles, next-step extraction, task
 * summaries) through Claude Code on the user's subscription login instead of an Anthropic or
 * OpenAI API key. Enabled with DEVFLOW_AI_PROVIDER=claude-code.
 *
 * Uses `ai-sdk-provider-claude-code` (an AI SDK provider built on the Claude Agent SDK). Auth is
 * whatever the `claude` CLI uses on this machine: the macOS Keychain login, or
 * CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` on Linux and in containers.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { createClaudeCode } from 'ai-sdk-provider-claude-code'

export type SubscriptionModelAlias = 'sonnet' | 'haiku'

export function isClaudeCodeSubscriptionEnabled(): boolean {
	return process.env.DEVFLOW_AI_PROVIDER === 'claude-code'
}

let provider: ReturnType<typeof createClaudeCode> | null = null

function claudeCode(alias: SubscriptionModelAlias) {
	provider ??= createClaudeCode({
		defaultSettings: {
			// Plain text/object generation: no built-in tools, no user or project settings
			// (keeps each call to ~1.3k input tokens), and no session files in ~/.claude/projects.
			tools: [],
			settingSources: [],
			persistSession: false,
			// Short extraction and titling prompts: skip extended thinking to cut latency.
			thinking: { type: 'disabled' },
		},
	})
	return provider(alias)
}

type GenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>

/**
 * The Agent SDK answers a JSON-schema request with a provider-executed `StructuredOutput` tool call
 * and finish reason `tool-calls`. `generateText({ output: Output.object(...) })` only parses output
 * from a step that finished with `stop`, so report the JSON as the step's only text and `stop`.
 */
function structuredOutputAsText(result: GenerateResult): GenerateResult {
	const structured = result.content.find((part) => part.type === 'tool-call' && part.toolName === 'StructuredOutput')
	if (!structured || structured.type !== 'tool-call') return result
	return {
		...result,
		content: [{ type: 'text', text: structured.input }],
		finishReason: { unified: 'stop', raw: result.finishReason.raw },
	}
}

/**
 * One provider model instance per request: an instance resumes the session it captured on its
 * first call, and with `persistSession: false` that session no longer exists on the next call.
 */
export function claudeCodeSubscriptionModel(alias: SubscriptionModelAlias): LanguageModelV3 {
	const template = claudeCode(alias)
	return {
		specificationVersion: template.specificationVersion,
		provider: template.provider,
		modelId: template.modelId,
		supportedUrls: template.supportedUrls,
		doGenerate: async (options: LanguageModelV3CallOptions) =>
			structuredOutputAsText(await claudeCode(alias).doGenerate(options)),
		doStream: (options: LanguageModelV3CallOptions) => claudeCode(alias).doStream(options),
	}
}
