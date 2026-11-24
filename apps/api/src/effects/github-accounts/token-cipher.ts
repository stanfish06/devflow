import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { Config, Context, Data, Effect, Layer, Option, Redacted } from 'effect'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** A token as stored: a fresh IV per encryption, and the ciphertext with the GCM tag appended. */
export interface EncryptedToken {
	readonly iv: Uint8Array
	readonly ciphertext: Uint8Array
}

/**
 * The server has no usable `GITHUB_ACCOUNT_TOKEN_KEY`, so it can neither store nor read GitHub
 * tokens. Everything else keeps working; only the procedures that touch a token fail.
 */
export class TokenStorageUnavailable extends Data.TaggedError('TokenStorageUnavailable')<{
	readonly reason: 'missing' | 'malformed'
}> {}

/** The ciphertext doesn't open with this key and context: a different key, or a tampered row. */
export class TokenDecryptFailed extends Data.TaggedError('TokenDecryptFailed')<{}> {}

export interface TokenCipherShape {
	/**
	 * Encrypt a token. `context` is bound in as additional authenticated data, so the ciphertext
	 * only opens for the same context (the row's owner), never after being copied to another row.
	 */
	readonly encrypt: (
		token: Redacted.Redacted<string>,
		context: string,
	) => Effect.Effect<EncryptedToken, TokenStorageUnavailable>
	readonly decrypt: (
		encrypted: EncryptedToken,
		context: string,
	) => Effect.Effect<Redacted.Redacted<string>, TokenStorageUnavailable | TokenDecryptFailed>
}

/** Encrypts GitHub account tokens at rest with AES-256-GCM under `GITHUB_ACCOUNT_TOKEN_KEY`. */
export class TokenCipher extends Context.Service<TokenCipher, TokenCipherShape>()('TokenCipher') {}

/** The 32-byte key from its base64 (or base64url) form, or null when it isn't one. */
export function parseTokenKey(encoded: string): Uint8Array | null {
	const trimmed = encoded.trim()
	// Node's base64 decoder skips characters outside the alphabet, so reject them first.
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null
	const key = Uint8Array.from(Buffer.from(trimmed, 'base64'))
	return key.length === KEY_BYTES ? key : null
}

/** A cipher over `key`, or one whose every call fails with `unavailable` when there is no usable key. */
export function makeTokenCipher(key: Uint8Array | TokenStorageUnavailable): TokenCipherShape {
	if (key instanceof TokenStorageUnavailable) {
		return { encrypt: () => Effect.fail(key), decrypt: () => Effect.fail(key) }
	}
	return {
		encrypt: (token, context) =>
			Effect.sync(() => {
				const iv = randomBytes(IV_BYTES)
				const cipher = createCipheriv(ALGORITHM, key, iv)
				cipher.setAAD(Buffer.from(context, 'utf8'))
				const body = Buffer.concat([cipher.update(Redacted.value(token), 'utf8'), cipher.final()])
				return {
					iv: Uint8Array.from(iv),
					ciphertext: Uint8Array.from(Buffer.concat([body, cipher.getAuthTag()])),
				}
			}),
		decrypt: (encrypted, context) =>
			Effect.try({
				try: () => {
					if (encrypted.iv.length !== IV_BYTES || encrypted.ciphertext.length < TAG_BYTES)
						throw new Error('Malformed encrypted token')
					const body = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - TAG_BYTES)
					const tag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - TAG_BYTES)
					const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv)
					decipher.setAAD(Buffer.from(context, 'utf8'))
					decipher.setAuthTag(tag)
					const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
					return Redacted.make(plaintext)
				},
				// The cause is dropped on purpose: nothing about a failed decrypt is worth logging.
				catch: () => new TokenDecryptFailed(),
			}),
	}
}

/**
 * Reads `GITHUB_ACCOUNT_TOKEN_KEY` (32 random bytes, base64) once. A missing or malformed key
 * doesn't stop the API: it is logged, and only the GitHub-account procedures that touch a token
 * fail, with `TokenStorageUnavailable`.
 */
export const TokenCipherLive = Layer.effect(
	TokenCipher,
	Effect.gen(function* () {
		const configured = yield* Config.option(Config.Redacted('GITHUB_ACCOUNT_TOKEN_KEY')).pipe(
			Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
		)
		if (Option.isNone(configured) || Redacted.value(configured.value).trim() === '') {
			yield* Effect.logWarning('GITHUB_ACCOUNT_TOKEN_KEY is not set; GitHub accounts cannot be stored')
			return makeTokenCipher(new TokenStorageUnavailable({ reason: 'missing' }))
		}
		const key = parseTokenKey(Redacted.value(configured.value))
		if (key === null) {
			yield* Effect.logError('GITHUB_ACCOUNT_TOKEN_KEY must be 32 bytes, base64-encoded')
			return makeTokenCipher(new TokenStorageUnavailable({ reason: 'malformed' }))
		}
		return makeTokenCipher(key)
	}),
)
