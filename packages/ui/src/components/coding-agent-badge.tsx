import { Badge } from '@devflow/ui/components/badge'
import { PROVIDER_LABELS, type ProviderOption } from '@devflow/ui/constants/providers'
import { cn } from '@devflow/ui/lib/utils'
import type { CodingAgent } from '@devflow/schemas/coding-agent'
import type { ComponentProps } from 'react'

export type SessionCodingAgent = CodingAgent

/**
 * Resolve the user-facing label for a session's coding agent:
 * - `claude` → "Claude Code" (devflow UI / Agent SDK)
 * - `codelayer` + `codex` → "Codex"
 * - other `codelayer` sessions → "CodeLayer (<provider>)" when known, else "CodeLayer"
 * - `pi` → "pi" (the pi-devflow extension)
 * - `codex` → "Codex" (a Codex CLI session the codex-devflow plugin mirrors)
 * - `claude-code` → "Claude Code" (a session the user started, which the devflow Claude Code plugin mirrors)
 * - `opencode` / unknown → "OpenCode" / a humanized fallback
 */
export function getCodingAgentLabel(
	codingAgent: string | null | undefined,
	provider?: string | null,
): string {
	switch (codingAgent) {
		case 'claude':
		case 'claude-code':
			return 'Claude Code'
		case 'codelayer': {
			if (provider === 'codex') return 'Codex'
			const providerLabel = provider ? PROVIDER_LABELS[provider as ProviderOption] : undefined
			return providerLabel ? `CodeLayer (${providerLabel})` : 'CodeLayer'
		}
		case 'opencode':
			return 'OpenCode'
		case 'fold':
			return 'Fold'
		case 'pi':
			return 'pi'
		case 'codex':
			return 'Codex'
		default:
			return codingAgent ? codingAgent : 'Claude Code'
	}
}

export interface CodingAgentBadgeProps extends Omit<ComponentProps<typeof Badge>, 'children'> {
	codingAgent: string | null | undefined
	provider?: string | null
}

/** Compact, provider-aware label for a session's coding agent. */
export function CodingAgentBadge({ codingAgent, provider, className, variant = 'outline', ...props }: CodingAgentBadgeProps) {
	return (
		<Badge
			variant={variant}
			className={cn('font-mono text-[10px] uppercase tracking-wider', className)}
			{...props}
		>
			{getCodingAgentLabel(codingAgent, provider)}
		</Badge>
	)
}
