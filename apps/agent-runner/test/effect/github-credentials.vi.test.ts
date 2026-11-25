import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as BunServices from '@effect/platform-bun/BunServices'
import { Effect, Exit, Layer, Scope } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import { DaemonGithubTokenResolveError } from '@/effects/services/daemon-api/daemon-api.errors'
import { makeGithubCredentials } from '@/effects/services/github-credentials/github-credentials.layer'
import type { GithubCredentialsService } from '@/effects/services/github-credentials/github-credentials.service'

import { makeMockDaemonApiLayer } from '../mocks/daemon-api.mock'

const TOKEN = 'github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz0123456789'
const ROTATED_TOKEN = 'ghp_rotated000000000000000000000000000000'
const SESSION_ID = '01a20f22-9699-78f3-badc-974bce4771af'
const OTHER_SESSION_ID = '01a20f22-9699-78f3-badc-974bce4771b0'

const scratch = mkdtempSync(join(tmpdir(), 'github-credentials-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type Resolution =
	| { accountId: string; login: string; name: string | null; email: string; token: string }
	| { useHostLogin: true }

const account = (token = TOKEN): Resolution => ({
	accountId: '01a20f22-0000-7000-8000-000000000001',
	login: 'stan-work',
	name: 'Stan',
	email: '1001+stan-work@users.noreply.github.com',
	token,
})

const modeOf = (path: string) => statSync(path).mode & 0o777

/**
 * A credential service over a fresh run directory, with the API answering `resolve` (a resolution,
 * or a function of the session id). Returns the service, the run directory, the API calls it saw,
 * and the scope that stands in for the daemon's lifetime.
 */
const setup = async (
	resolve: Resolution | ((sessionId: string) => Resolution | 'fail'),
	options: { hostGitConfigPaths?: string[] } = {},
) => {
	const runDirectory = join(mkdtempSync(join(scratch, 'daemon-')), 'run')
	const calls: string[] = []
	const api = makeMockDaemonApiLayer({
		resolveGithubToken: ({ sessionId }) =>
			Effect.suspend(() => {
				calls.push(sessionId)
				const result = typeof resolve === 'function' ? resolve(sessionId) : resolve
				return result === 'fail'
					? Effect.fail(new DaemonGithubTokenResolveError({ sessionId, cause: new Error('API down') }))
					: Effect.succeed(result)
			}),
	})
	const scope = await Effect.runPromise(Scope.make())
	const service = await Effect.runPromise(
		makeGithubCredentials({
			runDirectory,
			hostGitConfigPaths: options.hostGitConfigPaths ?? ['/home/me/.gitconfig'],
		}).pipe(Effect.provide(Layer.mergeAll(api, BunServices.layer)), Scope.provide(scope)),
	)
	return { service, runDirectory, calls, scope }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

const prepare = (
	service: GithubCredentialsService,
	sessionId = SESSION_ID,
	scope: 'host' | 'sandbox' = 'host',
	taskId = 'task-1',
) => service.prepare({ sessionId, taskId, scope })

describe('GithubCredentials', () => {
	it('writes a private credential directory and points gh and git at it', async () => {
		const { service, runDirectory } = await setup(account())
		const githubEnv = await run(prepare(service))

		const directory = join(runDirectory, SESSION_ID, 'github')
		expect(githubEnv).toEqual({
			GH_CONFIG_DIR: join(directory, 'gh'),
			GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
		})
		for (const path of [runDirectory, join(runDirectory, SESSION_ID), directory, join(directory, 'gh')]) {
			expect(modeOf(path), path).toBe(0o700)
		}
		for (const file of ['token', 'gitconfig', 'gh/hosts.yml', 'gh/config.yml']) {
			expect(modeOf(join(directory, file)), file).toBe(0o600)
		}
		expect(readFileSync(join(directory, 'token'), 'utf8')).toBe(`${TOKEN}\n`)
		expect(readFileSync(join(directory, 'gh/hosts.yml'), 'utf8')).toContain(`oauth_token: "${TOKEN}"`)
		const gitconfig = readFileSync(join(directory, 'gitconfig'), 'utf8')
		expect(gitconfig).toContain('email = "1001+stan-work@users.noreply.github.com"')
		expect(gitconfig).not.toContain(TOKEN)
	})

	it.each([
		{ scope: 'host' as const, includes: true },
		{ scope: 'sandbox' as const, includes: false },
	])("$scope: includes the user's own git config only on the host", async ({ scope, includes }) => {
		const { service, runDirectory } = await setup(account(), { hostGitConfigPaths: ['/home/me/.gitconfig'] })
		await run(prepare(service, SESSION_ID, scope))
		const gitconfig = readFileSync(join(runDirectory, SESSION_ID, 'github', 'gitconfig'), 'utf8')
		expect(gitconfig.includes('path = "/home/me/.gitconfig"')).toBe(includes)
	})

	it("writes nothing when the session keeps the host's own gh login", async () => {
		const { service, runDirectory, calls } = await setup({ useHostLogin: true })
		await expect(run(prepare(service))).resolves.toBeNull()
		expect(calls).toEqual([SESSION_ID])
		expect(existsSync(runDirectory)).toBe(false)
		await run(service.release(SESSION_ID))
		// A release without a hold is harmless.
		await run(service.release(SESSION_ID))
	})

	it("removes the session's directory on release, and leaves other sessions alone", async () => {
		const { service, runDirectory } = await setup(account())
		await run(prepare(service, SESSION_ID))
		await run(prepare(service, OTHER_SESSION_ID))

		await run(service.release(SESSION_ID))

		expect(existsSync(join(runDirectory, SESSION_ID))).toBe(false)
		expect(existsSync(join(runDirectory, OTHER_SESSION_ID, 'github', 'token'))).toBe(true)
	})

	it('keeps the directory until the last run of the session releases it', async () => {
		const { service, runDirectory } = await setup(account())
		await run(prepare(service))
		await run(prepare(service))

		await run(service.release(SESSION_ID))
		expect(existsSync(join(runDirectory, SESSION_ID, 'github', 'token'))).toBe(true)
		await run(service.release(SESSION_ID))
		expect(existsSync(join(runDirectory, SESSION_ID))).toBe(false)
	})

	it('rewrites the files in place when the session is prepared again', async () => {
		let token = TOKEN
		const { service, runDirectory } = await setup(() => account(token))
		await run(prepare(service))
		token = ROTATED_TOKEN
		await run(prepare(service))

		const directory = join(runDirectory, SESSION_ID, 'github')
		expect(readFileSync(join(directory, 'token'), 'utf8')).toBe(`${ROTATED_TOKEN}\n`)
		expect(readFileSync(join(directory, 'gh/hosts.yml'), 'utf8')).not.toContain(TOKEN)
		expect(modeOf(join(directory, 'token'))).toBe(0o600)
	})

	it('fails without writing anything when the API cannot say which account to use', async () => {
		const { service, runDirectory } = await setup(() => 'fail')
		const exit = await runExit(prepare(service))
		expect(Exit.isFailure(exit)).toBe(true)
		if (Exit.isFailure(exit)) {
			expect(JSON.stringify(exit.cause)).toContain('"reason":"resolve"')
		}
		expect(existsSync(runDirectory)).toBe(false)
	})

	it('refuses an account it cannot write safely, without echoing the token', async () => {
		const badToken = `${TOKEN}\nuser: someone-else`
		const { service, runDirectory } = await setup(account(badToken))
		const exit = await runExit(prepare(service))
		expect(Exit.isFailure(exit)).toBe(true)
		if (Exit.isFailure(exit)) {
			const cause = JSON.stringify(exit.cause)
			expect(cause).toContain('"reason":"invalid"')
			expect(cause).not.toContain(TOKEN)
		}
		expect(existsSync(runDirectory)).toBe(false)
	})

	it('refuses a session id that is not a UUID before asking the API', async () => {
		const { service, calls } = await setup(account())
		const exit = await runExit(prepare(service, '../../somewhere'))
		expect(Exit.isFailure(exit)).toBe(true)
		expect(calls).toEqual([])
	})

	it('fails with a write error, and leaves no files, when the directory cannot be written', async () => {
		const { service, runDirectory } = await setup(account())
		// The run directory's place is taken by a file.
		mkdirSync(join(runDirectory, '..'), { recursive: true })
		writeFileSync(runDirectory, 'not a directory')
		const exit = await runExit(prepare(service))
		expect(Exit.isFailure(exit)).toBe(true)
		if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain('"reason":"write"')
	})

	it('tightens a run directory that already existed with looser permissions', async () => {
		const { service, runDirectory } = await setup(account())
		mkdirSync(runDirectory, { recursive: true, mode: 0o755 })
		await run(prepare(service))
		expect(modeOf(runDirectory)).toBe(0o700)
	})

	describe("a mid-run switch of the task's account", () => {
		const personal = (): Resolution => ({
			accountId: '01a20f22-0000-7000-8000-000000000002',
			login: 'stan-personal',
			name: 'Stan P',
			email: '1002+stan-personal@users.noreply.github.com',
			token: ROTATED_TOKEN,
		})
		const read = (runDirectory: string, file: string, sessionId = SESSION_ID) =>
			readFileSync(join(runDirectory, sessionId, 'github', file), 'utf8')

		it("rewrites another account's files in place, for that task's sessions only", async () => {
			let current = account()
			const { service, runDirectory, calls } = await setup(() => current)
			const env = await run(prepare(service, SESSION_ID, 'host', 'task-1'))
			await run(prepare(service, OTHER_SESSION_ID, 'host', 'task-2'))
			calls.length = 0

			current = personal()
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'applied' },
			])

			expect(calls).toEqual([SESSION_ID])
			expect(read(runDirectory, 'token')).toBe(`${ROTATED_TOKEN}\n`)
			expect(read(runDirectory, 'gh/hosts.yml')).toContain('user: "stan-personal"')
			expect(read(runDirectory, 'gh/hosts.yml')).not.toContain(TOKEN)
			expect(read(runDirectory, 'gitconfig')).toContain('email = "1002+stan-personal@users.noreply.github.com"')
			// Still the user's own config underneath: the session was prepared on the host.
			expect(read(runDirectory, 'gitconfig')).toContain('path = "/home/me/.gitconfig"')
			expect(modeOf(join(runDirectory, SESSION_ID, 'github', 'token'))).toBe(0o600)
			// The same paths the running agent's env already points at.
			expect(env).toEqual({
				GH_CONFIG_DIR: join(runDirectory, SESSION_ID, 'github', 'gh'),
				GIT_CONFIG_GLOBAL: join(runDirectory, SESSION_ID, 'github', 'gitconfig'),
			})
			expect(read(runDirectory, 'token', OTHER_SESSION_ID)).toBe(`${TOKEN}\n`)
		})

		it("locks the directory when the task moves to the host's own gh login, and asks for a restart", async () => {
			let current: Resolution = account()
			const { service, runDirectory } = await setup(() => current)
			await run(prepare(service))

			current = { useHostLogin: true }
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'restart' },
			])

			expect(read(runDirectory, 'token')).toBe('')
			expect(read(runDirectory, 'gh/hosts.yml')).not.toContain('oauth_token')
			const gitconfig = read(runDirectory, 'gitconfig')
			expect(gitconfig).not.toContain('[user]')
			expect(gitconfig).toContain('quit=1')
			expect(modeOf(join(runDirectory, SESSION_ID, 'github', 'gitconfig'))).toBe(0o600)

			// Switching back before the agent restarts opens it again as the account.
			current = account()
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'applied' },
			])
			expect(read(runDirectory, 'token')).toBe(`${TOKEN}\n`)
			expect(read(runDirectory, 'gitconfig')).toContain('[user]')
		})

		it('locks the directory, rather than keep the old account, when the new choice cannot be read', async () => {
			let fail = false
			const { service, runDirectory } = await setup(() => (fail ? 'fail' : account()))
			await run(prepare(service))

			fail = true
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'restart' },
			])
			expect(read(runDirectory, 'token')).toBe('')
		})

		it('asks for a restart, writing nothing, when a host-login session moves to an account', async () => {
			let current: Resolution = { useHostLogin: true }
			const { service, runDirectory } = await setup(() => current)
			await expect(run(prepare(service))).resolves.toBeNull()

			current = account()
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'restart' },
			])
			expect(existsSync(runDirectory)).toBe(false)
		})

		it('leaves a host-login session as it is when the task stays on the host login', async () => {
			const { service } = await setup({ useHostLogin: true })
			await run(prepare(service))
			await expect(run(service.refresh('task-1'))).resolves.toEqual([
				{ sessionId: SESSION_ID, outcome: 'applied' },
			])
		})

		it('forgets released sessions, so a later switch asks the API nothing', async () => {
			const { service, calls } = await setup(account())
			await run(prepare(service))
			await run(service.release(SESSION_ID))
			calls.length = 0

			await expect(run(service.refresh('task-1'))).resolves.toEqual([])
			expect(calls).toEqual([])
		})

		it('locks the directory an earlier run still uses when a later run of the session starts on the host login', async () => {
			let current: Resolution = account()
			const { service, runDirectory } = await setup(() => current)
			await run(prepare(service))
			current = { useHostLogin: true }
			await expect(run(prepare(service))).resolves.toBeNull()

			expect(read(runDirectory, 'token')).toBe('')
			await run(service.release(SESSION_ID))
			expect(existsSync(join(runDirectory, SESSION_ID))).toBe(true)
			await run(service.release(SESSION_ID))
			expect(existsSync(join(runDirectory, SESSION_ID))).toBe(false)
		})
	})

	it('removes every remaining directory when the daemon stops', async () => {
		const { service, runDirectory, scope } = await setup(account())
		await run(prepare(service, SESSION_ID))
		await run(prepare(service, OTHER_SESSION_ID))

		await run(Scope.close(scope, Exit.void))

		expect(existsSync(join(runDirectory, SESSION_ID))).toBe(false)
		expect(existsSync(join(runDirectory, OTHER_SESSION_ID))).toBe(false)
	})
})
