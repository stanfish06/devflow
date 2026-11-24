import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureEnvFileValue } from '../lib/env-file'

describe('ensureEnvFileValue', () => {
	let dir: string
	let path: string
	let generated: number
	const ensure = () =>
		ensureEnvFileValue({
			path,
			key: 'GITHUB_ACCOUNT_TOKEN_KEY',
			comment: 'Generated once.',
			generate: () => `key-${++generated}`,
		})

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'env-file-'))
		path = join(dir, '.env')
		generated = 0
	})

	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('creates an owner-only file with the generated value when there is none', () => {
		expect(ensure()).toBe('key-1')
		expect(parseEnv(readFileSync(path, 'utf8')).GITHUB_ACCOUNT_TOKEN_KEY).toBe('key-1')
		expect(statSync(path).mode & 0o777).toBe(0o600)
	})

	it('generates once and reads the same value on every later run', () => {
		expect(ensure()).toBe('key-1')
		expect(ensure()).toBe('key-1')
		expect(generated).toBe(1)
	})

	it('appends to an existing file without touching what is there', () => {
		writeFileSync(path, 'CLAUDE_CODE_OAUTH_TOKEN=abc')
		expect(ensure()).toBe('key-1')
		const contents = readFileSync(path, 'utf8')
		expect(contents.startsWith('CLAUDE_CODE_OAUTH_TOKEN=abc\n')).toBe(true)
		expect(parseEnv(contents)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'abc', GITHUB_ACCOUNT_TOKEN_KEY: 'key-1' })
	})

	it('keeps a value the file already sets', () => {
		writeFileSync(path, 'GITHUB_ACCOUNT_TOKEN_KEY=mine\n')
		expect(ensure()).toBe('mine')
		expect(generated).toBe(0)
		expect(readFileSync(path, 'utf8')).toBe('GITHUB_ACCOUNT_TOKEN_KEY=mine\n')
	})

	it('fills in a key that is present but empty, as .env.example leaves it', () => {
		writeFileSync(path, 'GITHUB_ACCOUNT_TOKEN_KEY=\n')
		expect(ensure()).toBe('key-1')
		expect(parseEnv(readFileSync(path, 'utf8')).GITHUB_ACCOUNT_TOKEN_KEY).toBe('key-1')
	})
})
