import type { TokenStorageUnavailable } from '../../../effects/github-accounts/token-cipher'

/** What the browser shows when GitHub rejects a pasted token. */
export const TOKEN_REJECTED_MESSAGE = "GitHub rejected this token. Check that it's pasted in full and hasn't expired."

/** What the browser shows when GitHub couldn't be asked about a token. */
export const GITHUB_UNREACHABLE_MESSAGE = "Couldn't check the token with GitHub. Try again in a moment."

/** Why the server can't store tokens, for whoever runs it. */
export const tokenStorageUnavailableMessage = (error: TokenStorageUnavailable) =>
	error.reason === 'missing'
		? "This devflow server can't store GitHub tokens: GITHUB_ACCOUNT_TOKEN_KEY isn't set."
		: "This devflow server can't store GitHub tokens: GITHUB_ACCOUNT_TOKEN_KEY isn't a base64-encoded 32-byte key."
