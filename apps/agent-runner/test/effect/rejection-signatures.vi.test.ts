import { describe, expect, it } from 'vitest'

import { matchGithubRejection, talksToGithub } from '@/effects/services/github-credentials/rejection-signatures'

// Output as git 2.4x and gh 2.10x print it for each way GitHub refuses an account.
const PUSH_DENIED = [
	'remote: Permission to acme/api.git denied to stan-work.',
	"fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403",
].join('\n')
const PUSH_BAD_TOKEN = [
	'remote: Invalid username or token. Password authentication is not supported for Git operations.',
	"fatal: Authentication failed for 'https://github.com/acme/api.git/'",
].join('\n')
const PUSH_NOT_FOUND = [
	'remote: Repository not found.',
	"fatal: repository 'https://github.com/acme/private.git/' not found",
].join('\n')
const GH_BAD_CREDENTIALS =
	'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login'
const GH_API_401 = 'gh: Requires authentication (HTTP 401)\n{"message":"Requires authentication"}'
const GH_PR_401 = 'pull request create failed: HTTP 401: Bad credentials (https://api.github.com/graphql)'

describe('matchGithubRejection', () => {
	it.each([
		{
			name: 'a push refused for the account',
			command: 'git push -u origin task-branch',
			output: PUSH_DENIED,
			signature: 'permission_denied',
			login: 'stan-work',
		},
		{
			name: 'a push with a revoked token',
			command: 'git push',
			output: PUSH_BAD_TOKEN,
			signature: 'authentication_failed',
			login: null,
		},
		{
			name: 'a push to a repository the token cannot see',
			command: 'cd api && git push origin HEAD',
			output: PUSH_NOT_FOUND,
			signature: 'repository_not_found',
			login: null,
		},
		{
			name: 'gh with a revoked token',
			command: 'gh pr create --draft --title "Fix" --body-file /tmp/body.md',
			output: GH_PR_401,
			signature: 'bad_credentials',
			login: null,
		},
		{
			name: 'gh auth status style output',
			command: 'gh pr view --json url',
			output: GH_BAD_CREDENTIALS,
			signature: 'bad_credentials',
			login: null,
		},
		{
			name: 'gh api answering 401',
			command: 'gh api user',
			output: GH_API_401,
			signature: 'http_401',
			login: null,
		},
		{
			name: 'a fetch with a revoked token',
			command: 'git fetch origin main',
			output: "fatal: Authentication failed for 'https://github.com/acme/api.git/'",
			signature: 'authentication_failed',
			login: null,
		},
		{
			name: 'a token in the remote URL',
			command: 'git push https://github.com/acme/api.git HEAD',
			output: "fatal: Authentication failed for 'https://x-access-token@github.com/acme/api.git/'",
			signature: 'authentication_failed',
			login: null,
		},
		{
			name: 'git called by path, with colour codes',
			command: '/usr/bin/git -C api push',
			output: '\u001b[31mremote: Permission to acme/api.git denied to stan-bot.\u001b[0m',
			signature: 'permission_denied',
			login: 'stan-bot',
		},
		{
			name: 'a push after other commands, in a chain',
			command: 'git add -A && git commit -m "wip" && git push',
			output: `[task 1a2b3c4] wip\n 1 file changed\n${PUSH_DENIED}`,
			signature: 'permission_denied',
			login: 'stan-work',
		},
	])('matches $name', ({ command, output, signature, login }) => {
		expect(matchGithubRejection({ command, output })).toMatchObject({ signature, login })
	})

	it.each([
		{
			name: 'a successful push',
			command: 'git push',
			output: 'To https://github.com/acme/api.git\n   1a2b..3c4d  main -> main',
		},
		{
			name: 'a grep for the signature text',
			command: 'grep -rn "Bad credentials" src',
			output: 'src/github.ts:12:  if (body.message === "Bad credentials") throw new HTTP401()',
		},
		{
			name: 'a test run that prints the signatures',
			command: 'bun test github-accounts',
			output: 'HTTP 401: Bad credentials\nPermission to acme/api.git denied to stan-work.',
		},
		{
			name: 'git grep, which never talks to GitHub',
			command: 'git grep "Authentication failed for"',
			output: "src/errors.ts: Authentication failed for 'https://github.com/acme/api.git/'",
		},
		{
			name: 'a clone of a repository that does not exist',
			command: 'git clone https://github.com/acme/typo.git',
			output: PUSH_NOT_FOUND,
		},
		{
			name: 'a failure on another host',
			command: 'git push gitlab main',
			output: "fatal: Authentication failed for 'https://gitlab.com/acme/api.git/'",
		},
		{
			name: 'a status code that only starts with 401',
			command: 'gh api /rate_limit',
			output: 'HTTP 4010 is not a status code',
		},
		{
			name: 'a gh call that works',
			command: 'gh pr create --draft',
			output: 'https://github.com/acme/api/pull/12',
		},
		{
			name: 'the word github in a command that is not gh',
			command: 'cat ~/.config/github/notes.txt',
			output: 'HTTP 401: Bad credentials',
		},
	])('ignores $name', ({ command, output }) => {
		expect(matchGithubRejection({ command, output })).toBeNull()
	})

	it('keeps a few lines around the match as the excerpt', () => {
		const output = ['Enumerating objects: 5, done.', 'Writing objects: 100%', PUSH_DENIED, 'error: failed'].join(
			'\n',
		)
		const match = matchGithubRejection({ command: 'git push', output })

		expect(match?.excerpt).toContain('remote: Permission to acme/api.git denied to stan-work.')
		expect(match?.excerpt).toContain('Writing objects: 100%')
		expect(match?.excerpt.split('\n').length).toBeLessThanOrEqual(5)
	})
})

describe('talksToGithub', () => {
	it.each([
		{ command: 'gh pr create', expected: true },
		{ command: 'git push', expected: true },
		{ command: 'git pull --rebase', expected: true },
		{ command: 'git ls-remote origin', expected: true },
		{ command: 'git status', expected: false },
		{ command: 'git commit -m "push the fix"', expected: false },
		{ command: 'echo github', expected: false },
		{ command: 'npm run push', expected: false },
	])('$command → $expected', ({ command, expected }) => {
		expect(talksToGithub(command)).toBe(expected)
	})
})
