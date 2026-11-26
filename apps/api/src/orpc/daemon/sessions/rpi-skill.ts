import type { SessionLabel } from '@devflow/db/tables/sessions'
import { Option, Schema } from 'effect'

const RPI_SKILL_NAMES = [
	'create-research-questions',
	'iterate-research-questions',
	'create-research',
	'iterate-research',
	'create-prd',
	'iterate-prd',
	'create-tdd',
	'iterate-tdd',
	'create-design-discussion',
	'iterate-design-discussion',
	'create-structure-outline',
	'iterate-structure-outline',
	'create-plan',
	'iterate-plan',
	'setup-worktree',
	'implement-plan',
	'implement-outline',
	'iterate-implementation',
	'describe-pr',
] as const
const RpiSkillName = Schema.Literals(RPI_SKILL_NAMES)
type RpiSkillName = (typeof RPI_SKILL_NAMES)[number]

const SkillToolInput = Schema.Struct({
	skill: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
})

// Map RPI skills to labels - defined outside handler to avoid recreation
export const skillToLabel: Record<RpiSkillName, SessionLabel> = {
	'create-research-questions': { name: 'rpi:research-questions', title: 'research-questions' },
	'iterate-research-questions': { name: 'rpi:research-questions', title: 'research-questions' },
	'create-research': { name: 'rpi:research', title: 'research' },
	'iterate-research': { name: 'rpi:research', title: 'research' },
	'create-prd': { name: 'rpi:design-prd', title: 'design-prd' },
	'iterate-prd': { name: 'rpi:design-prd', title: 'design-prd' },
	'create-tdd': { name: 'rpi:design-tdd', title: 'design-tdd' },
	'iterate-tdd': { name: 'rpi:design-tdd', title: 'design-tdd' },
	'create-design-discussion': { name: 'rpi:design', title: 'design' },
	'iterate-design-discussion': { name: 'rpi:design', title: 'design' },
	'create-structure-outline': { name: 'rpi:structure', title: 'structure' },
	'iterate-structure-outline': { name: 'rpi:structure', title: 'structure' },
	'create-plan': { name: 'rpi:plan', title: 'plan' },
	'iterate-plan': { name: 'rpi:plan', title: 'plan' },
	'setup-worktree': { name: 'rpi:worktree-setup', title: 'worktree-setup' },
	'implement-plan': { name: 'rpi:implementation', title: 'implementation' },
	'implement-outline': { name: 'rpi:implementation', title: 'implementation' },
	'iterate-implementation': { name: 'rpi:implementation', title: 'implementation' },
	'describe-pr': { name: 'rpi:describe-pr', title: 'describe-pr' },
}

/**
 * Extracts the normalized bare skill name from a Skill tool call.
 * Returns undefined if this isn't a Skill call or the skill name can't be parsed.
 */
export function extractSkillName(
	toolName: string | null | undefined,
	toolInputJson: unknown,
	requiredPlugin?: 'rpi',
): RpiSkillName | undefined {
	const normalizedToolName = toolName?.toLowerCase()
	if (normalizedToolName !== 'skill' || !toolInputJson) {
		return undefined
	}

	try {
		// Handle both string and object inputs
		const rawToolInput: unknown = typeof toolInputJson === 'string' ? JSON.parse(toolInputJson) : toolInputJson
		const toolInput = Option.getOrUndefined(Schema.decodeUnknownOption(SkillToolInput)(rawToolInput))
		const skillName = toolInput?.skill ?? toolInput?.name
		if (!skillName) return undefined

		// Existing phase labels accept plugin-qualified aliases. Only replay skills from the RPI plugin.
		const separator = skillName.lastIndexOf(':')
		if (requiredPlugin && separator !== -1 && skillName.slice(0, separator) !== requiredPlugin) return undefined
		const bareName = skillName.slice(separator + 1)
		return Option.getOrUndefined(Schema.decodeUnknownOption(RpiSkillName)(bareName))
	} catch {
		// Invalid JSON - not an RPI skill
		return undefined
	}
}
