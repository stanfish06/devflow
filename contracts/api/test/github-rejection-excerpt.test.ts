import { describe, expect, it } from 'vitest'

import {
	GITHUB_REJECTION_EXCERPT_MAX_LENGTH,
	githubRejectionExcerpt,
	redactGithubSecrets,
	ReportGithubRejectionInputSchema,
} from '../src/daemon/github-accounts/report-rejection'

const PAT = 'github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz0123456789'
const CLASSIC = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

describe('redactGithubSecrets', () => {
	it.each([
		{ name: 'a fine-grained PAT', text: `token is ${PAT} here`, secret: PAT },
		{ name: 'a classic PAT', text: `GH_TOKEN=${CLASSIC} gh pr create`, secret: CLASSIC },
		{
			name: 'an OAuth token',
			text: 'gho_abcdefghijklmnopqrstuvwxyz0123',
			secret: 'gho_abcdefghijklmnopqrstuvwxyz0123',
		},
		{
			name: 'credentials in a remote URL',
			text: "fatal: Authentication failed for 'https://stan:hunter2hunter2@github.com/acme/api.git/'",
			secret: 'hunter2hunter2',
		},
		{
			name: 'an authorization header',
			text: '> Authorization: token abc123secretvalue',
			secret: 'abc123secretvalue',
		},
		{ name: 'a gh hosts.yml line', text: '    oauth_token: someopaquevalue1234', secret: 'someopaquevalue1234' },
	])('removes $name', ({ text, secret }) => {
		const redacted = redactGithubSecrets(text)
		expect(redacted).not.toContain(secret)
		expect(redacted).toContain('[redacted]')
	})

	it('removes a known secret of any shape, but not short strings that would eat ordinary words', () => {
		expect(redactGithubSecrets('the token opaque-secret-value leaked', ['opaque-secret-value'])).toBe(
			'the token [redacted] leaked',
		)
		expect(redactGithubSecrets('push denied', ['push'])).toBe('push denied')
	})

	it('keeps the parts that explain the failure', () => {
		const text =
			"remote: Permission to acme/api.git denied to stan-work.\nfatal: unable to access 'https://github.com/acme/api.git/'"
		expect(redactGithubSecrets(text)).toBe(text)
	})
})

describe('githubRejectionExcerpt', () => {
	it('redacts before cutting, so no part of a token survives at the edge', () => {
		const text = `${'x'.repeat(GITHUB_REJECTION_EXCERPT_MAX_LENGTH - 10)}${PAT}`
		const excerpt = githubRejectionExcerpt(text, [PAT])
		expect(excerpt.length).toBeLessThanOrEqual(GITHUB_REJECTION_EXCERPT_MAX_LENGTH)
		expect(excerpt).not.toContain('github_pat_')
		expect(ReportGithubRejectionInputSchema.shape.excerpt.safeParse(excerpt).success).toBe(true)
	})
})
