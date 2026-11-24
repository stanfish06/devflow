import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Redacted } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import {
	credentialPaths,
	credentialProblem,
	githubEnvFor,
	hostGlobalGitConfigPaths,
	renderGhConfigYml,
	renderGhHostsYml,
	renderGitconfig,
	renderTokenFile,
	withGithubEnvironment,
	type GithubAccountCredentials,
} from '@/effects/services/github-credentials/credential-files'

const TOKEN = 'github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz0123456789'
const SESSION_ID = '01a20f22-9699-78f3-badc-974bce4771af'

const account = (overrides: Partial<GithubAccountCredentials> = {}): GithubAccountCredentials => ({
	login: 'stan-work',
	name: 'Stan',
	email: '1001+stan-work@users.noreply.github.com',
	token: Redacted.make(TOKEN),
	...overrides,
})

const scratch = mkdtempSync(join(tmpdir(), 'credential-files-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Run git with only the given global config, the way an agent with the credential env would. */
const git = (gitconfig: string, args: string[], input?: string) =>
	spawnSync('git', args, {
		cwd: scratch,
		input,
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			HOME: scratch,
			GIT_CONFIG_GLOBAL: gitconfig,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
		},
	})

describe('credentialPaths', () => {
	it('lays the session out under run/<sessionId>/github', () => {
		const paths = credentialPaths('/home/me/.devflow/run', SESSION_ID)
		expect(paths).toEqual({
			sessionDirectory: `/home/me/.devflow/run/${SESSION_ID}`,
			directory: `/home/me/.devflow/run/${SESSION_ID}/github`,
			ghConfigDirectory: `/home/me/.devflow/run/${SESSION_ID}/github/gh`,
			ghHostsFile: `/home/me/.devflow/run/${SESSION_ID}/github/gh/hosts.yml`,
			ghConfigFile: `/home/me/.devflow/run/${SESSION_ID}/github/gh/config.yml`,
			tokenFile: `/home/me/.devflow/run/${SESSION_ID}/github/token`,
			gitconfigFile: `/home/me/.devflow/run/${SESSION_ID}/github/gitconfig`,
		})
		expect(githubEnvFor(paths)).toEqual({
			GH_CONFIG_DIR: `/home/me/.devflow/run/${SESSION_ID}/github/gh`,
			GIT_CONFIG_GLOBAL: `/home/me/.devflow/run/${SESSION_ID}/github/gitconfig`,
		})
	})

	it.each(['../../etc', 'session-1', '', `${SESSION_ID}/..`])('refuses a session id that is not a UUID: %j', (id) => {
		expect(() => credentialPaths('/run', id)).toThrow()
	})
})

describe('credentialProblem', () => {
	it.each([
		['a well-formed account', account(), null],
		['a token with a newline', account({ token: Redacted.make(`${TOKEN}\nuser: evil`) }), 'token'],
		['a token with a space', account({ token: Redacted.make('ghp abc') }), 'token'],
		['an empty token', account({ token: Redacted.make('') }), 'token'],
		['a login with a newline', account({ login: 'stan\nwork' }), 'login'],
		['a name with a newline', account({ name: 'Stan\n[core]' }), 'name'],
		['a name with spaces and quotes', account({ name: 'Stan "the" Man' }), null],
		['no name', account({ name: null }), null],
	])('%s', (_label, input, problem) => {
		const result = credentialProblem(input)
		if (problem === null) expect(result).toBeNull()
		else expect(result).toContain(problem)
		// Never names the token, whatever is wrong.
		expect(result ?? '').not.toContain(TOKEN)
	})
})

describe('renderGhHostsYml', () => {
	it('logs gh in to github.com as the account only', () => {
		expect(renderGhHostsYml(account())).toBe(
			[
				'github.com:',
				'    git_protocol: https',
				'    users:',
				'        "stan-work":',
				`            oauth_token: "${TOKEN}"`,
				`    oauth_token: "${TOKEN}"`,
				'    user: "stan-work"',
				'',
			].join('\n'),
		)
	})

	it('marks the gh config as already migrated', () => {
		expect(renderGhConfigYml()).toContain('version: "1"')
	})

	it('writes the token file as the token alone', () => {
		expect(renderTokenFile(account())).toBe(`${TOKEN}\n`)
	})
})

describe('renderGitconfig', () => {
	it.each([
		{ scope: 'sandboxed', includePaths: [] as string[] },
		{ scope: 'non-sandboxed', includePaths: ['/home/me/.config/git/config', '/home/me/.gitconfig'] },
	])('$scope: includes only the host configs it is given, then the account', ({ includePaths }) => {
		const rendered = renderGitconfig({ account: account(), tokenFile: '/run/s/github/token', includePaths })
		if (includePaths.length === 0) expect(rendered).not.toContain('[include]')
		else
			expect(rendered).toContain(
				'[include]\n\tpath = "/home/me/.config/git/config"\n\tpath = "/home/me/.gitconfig"\n',
			)
		// The account's settings come after the include, so they win over the user's own.
		expect(rendered.indexOf('[user]')).toBeGreaterThan(rendered.indexOf('[include]'))
		expect(rendered).toContain('[user]\n\tname = "Stan"\n\temail = "1001+stan-work@users.noreply.github.com"\n')
		expect(rendered).toContain('[credential "https://github.com"]\n\thelper = ""\n')
		// The token is read from its file, never written into the config.
		expect(rendered).not.toContain(TOKEN)
	})

	it('falls back to the login as the author name when the profile has none', () => {
		const rendered = renderGitconfig({ account: account({ name: null }), tokenFile: '/t', includePaths: [] })
		expect(rendered).toContain('\tname = "stan-work"\n')
	})

	it('makes git commit as the account and answer credentials with its token', () => {
		const directory = mkdtempSync(join(scratch, 'git-'))
		const tokenFile = join(directory, "token with 'quote'")
		writeFileSync(tokenFile, renderTokenFile(account()))
		const userConfig = join(directory, 'user-gitconfig')
		// The user's own config: another identity and a credential helper that would answer first.
		writeFileSync(
			userConfig,
			'[user]\n\tname = Host User\n\temail = me@example.com\n[credential]\n\thelper = "!echo password=host-secret; :"\n[core]\n\tabbrev = 12\n',
		)
		const gitconfig = join(directory, 'gitconfig')
		writeFileSync(
			gitconfig,
			renderGitconfig({ account: account({ name: 'Stan "S" W' }), tokenFile, includePaths: [userConfig] }),
		)

		expect(git(gitconfig, ['config', 'user.name']).stdout.trim()).toBe('Stan "S" W')
		expect(git(gitconfig, ['config', 'user.email']).stdout.trim()).toBe('1001+stan-work@users.noreply.github.com')
		// The user's unrelated settings still apply.
		expect(git(gitconfig, ['config', 'core.abbrev']).stdout.trim()).toBe('12')

		const filled = git(gitconfig, ['credential', 'fill'], 'protocol=https\nhost=github.com\npath=org/repo.git\n\n')
		expect(filled.status).toBe(0)
		expect(filled.stdout).toContain('username=stan-work\n')
		expect(filled.stdout).toContain(`password=${TOKEN}\n`)
		expect(filled.stdout).not.toContain('host-secret')

		// `git config --list`, which an agent might print, never shows the token.
		expect(git(gitconfig, ['config', '--list']).stdout).not.toContain(TOKEN)
	})

	it('sends SSH GitHub remotes over HTTPS so pushes use the account', () => {
		const directory = mkdtempSync(join(scratch, 'url-'))
		const gitconfig = join(directory, 'gitconfig')
		writeFileSync(gitconfig, renderGitconfig({ account: account(), tokenFile: '/t', includePaths: [] }))
		const repository = join(directory, 'repo')
		spawnSync('git', ['init', '-q', repository])
		spawnSync('git', ['-C', repository, 'remote', 'add', 'origin', 'git@github.com:org/repo.git'])
		const pushUrl = spawnSync('git', ['-C', repository, 'remote', 'get-url', '--push', 'origin'], {
			encoding: 'utf8',
			env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
		})
		expect(pushUrl.stdout.trim()).toBe('https://github.com/org/repo.git')
	})
})

describe('hostGlobalGitConfigPaths', () => {
	it.each([
		[{ HOME: '/home/me' }, ['/home/me/.config/git/config', '/home/me/.gitconfig']],
		[{ HOME: '/home/me', XDG_CONFIG_HOME: '/xdg' }, ['/xdg/git/config', '/home/me/.gitconfig']],
		[{ HOME: '/home/me', GIT_CONFIG_GLOBAL: '/custom/gitconfig' }, ['/custom/gitconfig']],
		[{}, []],
	])('%j → %j', (env, expected) => {
		expect(hostGlobalGitConfigPaths(env)).toEqual(expected)
	})
})

describe('withGithubEnvironment', () => {
	const inherited = {
		PATH: '/bin',
		GH_TOKEN: 'host-token',
		GITHUB_TOKEN: 'host-token-2',
		GIT_AUTHOR_NAME: 'Host',
		GIT_AUTHOR_EMAIL: 'host@example.com',
		GIT_COMMITTER_NAME: 'Host',
		GIT_COMMITTER_EMAIL: 'host@example.com',
		GIT_CONFIG_GLOBAL: '/home/me/custom-gitconfig',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'core.hooksPath',
		GIT_CONFIG_VALUE_0: '/hooks',
		GH_CONFIG_DIR: undefined,
	}
	const githubEnv = { GH_CONFIG_DIR: '/run/s/github/gh', GIT_CONFIG_GLOBAL: '/run/s/github/gitconfig' }

	it('leaves the env exactly as it was when the session keeps the host login', () => {
		expect(withGithubEnvironment(inherited, null)).toEqual(inherited)
	})

	it('drops every override and points gh and git at the credential directory', () => {
		expect(withGithubEnvironment(inherited, githubEnv)).toEqual({
			PATH: '/bin',
			GIT_CONFIG_GLOBAL: '/run/s/github/gitconfig',
			GH_CONFIG_DIR: '/run/s/github/gh',
			// Commit attribution layers on top through GIT_CONFIG_COUNT, untouched.
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/hooks',
		})
	})
})
