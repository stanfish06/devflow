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

const prepare = (service: GithubCredentialsService, sessionId = SESSION_ID, scope: 'host' | 'sandbox' = 'host') =>
	service.prepare({ sessionId, taskId: 'task-1', scope })

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

	it('removes every remaining directory when the daemon stops', async () => {
		const { service, runDirectory, scope } = await setup(account())
		await run(prepare(service, SESSION_ID))
		await run(prepare(service, OTHER_SESSION_ID))

		await run(Scope.close(scope, Exit.void))

		expect(existsSync(join(runDirectory, SESSION_ID))).toBe(false)
		expect(existsSync(join(runDirectory, OTHER_SESSION_ID))).toBe(false)
	})
})
