/** Explicit composer and slash commands. The API also uses the capture groups in PostgreSQL. */
export const rpiSkillRequestPattern = /^\s*(?:use the \/?rpi:([a-z0-9-]+) skill|\/rpi:([a-z0-9-]+))(?=\s|$)/i

export function requestedRpiSkill(prompt: string): string | undefined {
	const match = rpiSkillRequestPattern.exec(prompt)
	return (match?.[1] ?? match?.[2])?.toLowerCase()
}
