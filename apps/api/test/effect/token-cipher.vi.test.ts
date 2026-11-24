import { randomBytes } from 'node:crypto'

import { describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Exit, Redacted } from 'effect'
import { expect } from 'vitest'

import {
	makeTokenCipher,
	parseTokenKey,
	TokenCipher,
	TokenCipherLive,
	TokenStorageUnavailable,
} from '../../src/effects/github-accounts/token-cipher'

const KEY = Uint8Array.from(randomBytes(32))
const OTHER_KEY = Uint8Array.from(randomBytes(32))
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'
const CONTEXT = 'github_accounts:org-1:user-1'

const flipFirstByte = (bytes: Uint8Array) => {
	const copy = Uint8Array.from(bytes)
	copy[0] = (copy[0] ?? 0) ^ 0xff
	return copy
}

describe('TokenCipher', () => {
	it.effect('round-trips a token, and the ciphertext is not the token', () =>
		Effect.gen(function* () {
			const cipher = makeTokenCipher(KEY)
			const encrypted = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)

			expect(encrypted.iv).toHaveLength(12)
			expect(Buffer.from(encrypted.ciphertext).toString('utf8')).not.toContain(TOKEN)
			expect(Buffer.from(encrypted.ciphertext).includes(Buffer.from(TOKEN))).toBe(false)
			expect(Redacted.value(yield* cipher.decrypt(encrypted, CONTEXT))).toBe(TOKEN)
		}),
	)

	it.effect('uses a fresh IV for every encryption', () =>
		Effect.gen(function* () {
			const cipher = makeTokenCipher(KEY)
			const first = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)
			const second = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)

			expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false)
			expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false)
		}),
	)

	it.effect.each([
		[
			'a tampered ciphertext',
			(e: { iv: Uint8Array; ciphertext: Uint8Array }) => ({ ...e, ciphertext: flipFirstByte(e.ciphertext) }),
		],
		[
			'a tampered tag',
			(e: { iv: Uint8Array; ciphertext: Uint8Array }) => ({
				...e,
				ciphertext: Uint8Array.from([...e.ciphertext.slice(0, -1), (e.ciphertext.at(-1) ?? 0) ^ 1]),
			}),
		],
		['a tampered IV', (e: { iv: Uint8Array; ciphertext: Uint8Array }) => ({ ...e, iv: flipFirstByte(e.iv) })],
		[
			'a truncated ciphertext',
			(e: { iv: Uint8Array; ciphertext: Uint8Array }) => ({ ...e, ciphertext: e.ciphertext.slice(0, 8) }),
		],
	] as const)('refuses %s', ([, tamper]) =>
		Effect.gen(function* () {
			const cipher = makeTokenCipher(KEY)
			const encrypted = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)
			const result = yield* Effect.flip(cipher.decrypt(tamper(encrypted), CONTEXT))
			expect(result._tag).toBe('TokenDecryptFailed')
		}),
	)

	it.effect('refuses the wrong key', () =>
		Effect.gen(function* () {
			const encrypted = yield* makeTokenCipher(KEY).encrypt(Redacted.make(TOKEN), CONTEXT)
			const result = yield* Effect.flip(makeTokenCipher(OTHER_KEY).decrypt(encrypted, CONTEXT))
			expect(result._tag).toBe('TokenDecryptFailed')
		}),
	)

	it.effect('refuses another owner’s context, so a ciphertext copied to their row stays shut', () =>
		Effect.gen(function* () {
			const cipher = makeTokenCipher(KEY)
			const encrypted = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)
			const result = yield* Effect.flip(cipher.decrypt(encrypted, 'github_accounts:org-1:user-2'))
			expect(result._tag).toBe('TokenDecryptFailed')
		}),
	)

	it.effect('fails every call when there is no usable key', () =>
		Effect.gen(function* () {
			const cipher = makeTokenCipher(new TokenStorageUnavailable({ reason: 'missing' }))
			const exit = yield* Effect.exit(cipher.encrypt(Redacted.make(TOKEN), CONTEXT))
			expect(Exit.isFailure(exit)).toBe(true)
			const error = yield* Effect.flip(cipher.encrypt(Redacted.make(TOKEN), CONTEXT))
			expect(error).toMatchObject({ _tag: 'TokenStorageUnavailable', reason: 'missing' })
		}),
	)
})

describe('parseTokenKey', () => {
	it.each([
		['base64 of 32 bytes', Buffer.from(KEY).toString('base64'), true],
		['base64url of 32 bytes', Buffer.from(KEY).toString('base64url'), true],
		['surrounding whitespace', ` ${Buffer.from(KEY).toString('base64')}\n`, true],
		['16 bytes', Buffer.from(KEY.slice(0, 16)).toString('base64'), false],
		['64 bytes', Buffer.from([...KEY, ...KEY]).toString('base64'), false],
		['not base64', 'not a key at all!', false],
		['empty', '', false],
	])('%s', (_, encoded, usable) => {
		expect(parseTokenKey(encoded) !== null).toBe(usable)
	})
})

describe('TokenCipherLive', () => {
	const withKey = (key: string | undefined) =>
		ConfigProvider.layer(ConfigProvider.fromUnknown(key === undefined ? {} : { GITHUB_ACCOUNT_TOKEN_KEY: key }))

	it.effect('reads GITHUB_ACCOUNT_TOKEN_KEY', () =>
		Effect.gen(function* () {
			const cipher = yield* TokenCipher
			const encrypted = yield* cipher.encrypt(Redacted.make(TOKEN), CONTEXT)
			const reopened = yield* makeTokenCipher(KEY).decrypt(encrypted, CONTEXT)
			expect(Redacted.value(reopened)).toBe(TOKEN)
		}).pipe(Effect.provide(TokenCipherLive), Effect.provide(withKey(Buffer.from(KEY).toString('base64')))),
	)

	it.effect.each([
		['missing', undefined],
		['malformed', 'too-short'],
	] as const)('still builds when the key is %s, and fails token calls', ([reason, key]) =>
		Effect.gen(function* () {
			const cipher = yield* TokenCipher
			const error = yield* Effect.flip(cipher.encrypt(Redacted.make(TOKEN), CONTEXT))
			expect(error).toMatchObject({ _tag: 'TokenStorageUnavailable', reason })
		}).pipe(Effect.provide(TokenCipherLive), Effect.provide(withKey(key))),
	)
})
