/**
 * True when `error` is jose's `JWTExpired` — the token's "exp" claim is in the past.
 *
 * These are expected: tokens are meant to expire, and clients then re-authenticate or
 * refresh, so the auth verifiers log them at debug instead of as errors.
 *
 * jose sets a stable `err.code = 'ERR_JWT_EXPIRED'` — a string literal that survives
 * bundling/minification, unlike the class name. The message check is a fallback.
 */
export function isExpiredJwtError(error: unknown): boolean {
	if (error !== null && typeof error === 'object') {
		const { code, message } = error as { code?: unknown; message?: unknown }
		if (code === 'ERR_JWT_EXPIRED') return true
		if (typeof message === 'string' && message.includes('"exp" claim timestamp check failed')) return true
	}
	return false
}
