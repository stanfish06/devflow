import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { githubCredentialMounts, sandboxEnvironment, sandboxLaunch } from '@/devflow/docker-sandbox'

const SESSION_ID = '01a20f22-9699-78f3-badc-974bce4771af'

const scratch = mkdtempSync(join(tmpdir(), 'docker-sandbox-'))
const runDirectory = join(scratch, 'devflow', 'run')
const githubDirectory = join(runDirectory, SESSION_ID, 'github')
const GITHUB_ENV = { GH_CONFIG_DIR: join(githubDirectory, 'gh'), GIT_CONFIG_GLOBAL: join(githubDirectory, 'gitconfig') }

const previousDevflowHome = process.env.DEVFLOW_HOME
beforeAll(() => {
	process.env.DEVFLOW_HOME = join(scratch, 'devflow')
	mkdirSync(GITHUB_ENV.GH_CONFIG_DIR, { recursive: true })
})
afterAll(() => {
	if (previousDevflowHome === undefined) delete process.env.DEVFLOW_HOME
	else process.env.DEVFLOW_HOME = previousDevflowHome
	rmSync(scratch, { recursive: true, force: true })
})

/** The env the SDK hands the spawner: the query options' env plus its own additions. */
const sdkEnv = {
	PATH: '/usr/bin',
	ANTHROPIC_API_KEY: 'sk-ant',
	CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
	DATABASE_URL: 'postgres://secret',
	GH_TOKEN: 'host-token',
	GIT_AUTHOR_NAME: 'Host',
	DEVFLOW_SESSION_ID: SESSION_ID,
}

describe('sandboxEnvironment', () => {
	const configDir = '/home/me/.devflow/sandbox/claude'

	it('passes the two credential pointers and drops every override when the session has an account', () => {
		const env = sandboxEnvironment(
			// The query options already stripped the overrides; a stray one must still not get in.
			{ ...sdkEnv, ...GITHUB_ENV, GITHUB_TOKEN: 'host-token-2', GIT_COMMITTER_EMAIL: 'host@example.com' },
			{ configDir, githubEnv: GITHUB_ENV },
		)
		expect(env).toEqual({
			ANTHROPIC_API_KEY: 'sk-ant',
			CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
			DEVFLOW_SESSION_ID: SESSION_ID,
			...GITHUB_ENV,
			CLAUDE_CONFIG_DIR: configDir,
			HOME: join(configDir, 'home'),
		})
	})

	it('takes the pointers only from the session, never from the inherited env', () => {
		const env = sandboxEnvironment(
			{ ...sdkEnv, GH_CONFIG_DIR: '/home/me/.config/gh', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig' },
			{ configDir, githubEnv: GITHUB_ENV },
		)
		expect(env).toMatchObject(GITHUB_ENV)
	})

	it("keeps exactly today's variables for a host-login session", () => {
		const env = sandboxEnvironment(
			{ ...sdkEnv, GH_CONFIG_DIR: '/home/me/.config/gh', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig' },
			{ configDir, githubEnv: null },
		)
		expect(env).toEqual({
			ANTHROPIC_API_KEY: 'sk-ant',
			CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
			GH_TOKEN: 'host-token',
			GIT_AUTHOR_NAME: 'Host',
			DEVFLOW_SESSION_ID: SESSION_ID,
			CLAUDE_CONFIG_DIR: configDir,
			HOME: join(configDir, 'home'),
		})
	})
})

describe('sandboxLaunch', () => {
	const cwd = mkdtempSync(join(scratch, 'worktree-'))

	it("mounts the session's credential directory at its host path", () => {
		const launch = sandboxLaunch(
			{ cwd, args: [], env: { ...sdkEnv, ...GITHUB_ENV } },
			{ cwd, mountPaths: [], githubEnv: GITHUB_ENV },
		)
		expect(launch.mounts).toEqual(expect.arrayContaining(githubCredentialMounts(GITHUB_ENV)))
		expect(githubCredentialMounts(GITHUB_ENV)).toEqual([GITHUB_ENV.GH_CONFIG_DIR, githubDirectory])
		expect(launch.env).toMatchObject(GITHUB_ENV)
		expect(launch.env).not.toHaveProperty('GH_TOKEN')
	})

	it('mounts nothing extra for a host-login session', () => {
		const launch = sandboxLaunch({ cwd, args: [], env: sdkEnv }, { cwd, mountPaths: [], githubEnv: null })
		expect(launch.mounts.some((mount) => mount?.startsWith(runDirectory))).toBe(false)
		expect(launch.env).toMatchObject({ GH_TOKEN: 'host-token' })
	})
})
