import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

/**
 * The value of `key` in the dotenv file at `path`. When the file doesn't set it, `generate()` makes
 * one and it is appended (the file is created, owner-only, if missing), so every later run reads
 * the same value. For secrets that must survive restarts, like an encryption key.
 */
export function ensureEnvFileValue(input: {
	readonly path: string
	readonly key: string
	readonly generate: () => string
	/** A line explaining the value, written above it. */
	readonly comment?: string
}): string {
	const contents = existsSync(input.path) ? readFileSync(input.path, 'utf8') : null
	const existing = contents === null ? undefined : parseEnv(contents)[input.key]
	if (existing) return existing
	const value = input.generate()
	const block = `${input.comment ? `# ${input.comment}\n` : ''}${input.key}=${value}\n`
	if (contents === null) writeFileSync(input.path, block, { mode: 0o600 })
	else appendFileSync(input.path, `${contents === '' || contents.endsWith('\n') ? '' : '\n'}\n${block}`)
	return value
}
