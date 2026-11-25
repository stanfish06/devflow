import { Data } from 'effect'

/** The account doesn't exist, or belongs to someone else (the two are indistinguishable on purpose). */
export class GithubAccountNotFound extends Data.TaggedError('GithubAccountNotFound')<{
	readonly accountId: string
}> {}

/** GitHub answered `GET /user` with 401: the token is wrong, expired or revoked. */
export class GithubTokenRejected extends Data.TaggedError('GithubTokenRejected')<{
	readonly status: number
}> {}

/**
 * GitHub couldn't be asked, or didn't answer with a user. Carries no cause: the request held the
 * token in its headers, and nothing here is worth the risk of logging it.
 */
export class GithubUnreachable extends Data.TaggedError('GithubUnreachable')<{
	readonly reason: 'transport' | 'status' | 'decode'
	readonly status?: number
}> {}

/** A replacement token belongs to a different GitHub user than the account it was meant for. */
export class GithubAccountMismatch extends Data.TaggedError('GithubAccountMismatch')<{
	readonly expectedLogin: string
	readonly actualLogin: string
}> {}
