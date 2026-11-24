import { Effect, Exit } from 'effect'
import { describe, expect, test, vi } from 'vitest'

// `Effect.tryPromise` invokes its `try` callback with an `AbortSignal`. `materializeRpiPlugin`
// must call `ensureRpiPluginOnDisk()` with NO arguments, otherwise that signal is forwarded as the
// optional `baseDir` and `path.join(signal, …)` throws `TypeError: paths[0] … must be of type
// string`, failing every Effect-runtime Claude launch (see PR #1800 regression).
const { ensureRpiPluginOnDiskMock } = vi.hoisted(() => ({
	ensureRpiPluginOnDiskMock: vi.fn(() => Promise.resolve('/mock/rpi/plugin')),
}))

vi.mock('@/plugins/ensure-plugin', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/plugins/ensure-plugin')>()
	return { ...actual, ensureRpiPluginOnDisk: ensureRpiPluginOnDiskMock }
})

import { DEFAULT_EFFECTIVE_SETTINGS } from '@/agents/claudecode/effective-settings'
import {
	materializeRpiPlugin,
	readGithubCredentialEnvironment,
} from '@/effects/services/claude-sessions/claude-session-preparation-adapters'
import { buildClaudeQueryOptions } from '@/effects/services/claude-sessions/query-options'
import { GithubCredentialsError } from '@/effects/services/github-credentials/github-credentials.service'

import { makeBasicEffectSession } from '../fixtures/effect-claude-runtime'
import { makeHostLoginGithubCredentials } from '../mocks/github-credentials.mock'

describe('materializeRpiPlugin', () => {
	test('calls ensureRpiPluginOnDisk with no arguments (does not forward tryPromise AbortSignal as baseDir)', async () => {
		ensureRpiPluginOnDiskMock.mockClear()

		const pluginPath = await Effect.runPromise(materializeRpiPlugin())

		expect(pluginPath).toBe('/mock/rpi/plugin')
		expect(ensureRpiPluginOnDiskMock).toHaveBeenCalledTimes(1)
		// The bug forwarded the AbortSignal here; the fix passes nothing.
		expect(ensureRpiPluginOnDiskMock.mock.calls[0]).toHaveLength(0)
	})
})

const SESSION_ID = '01a20f22-9699-78f3-badc-974bce4771af'
const GITHUB_ENV = {
	GH_CONFIG_DIR: `/home/me/.devflow/run/${SESSION_ID}/github/gh`,
	GIT_CONFIG_GLOBAL: `/home/me/.devflow/run/${SESSION_ID}/github/gitconfig`,
}

/** GithubCredentials that hands out `result` and records every prepare and release. */
const recordingCredentials = (result: typeof GITHUB_ENV | null | 'fail') => {
	const calls: string[] = []
	const layer = makeHostLoginGithubCredentials({
		prepare: (input) =>
			Effect.suspend(() => {
				calls.push(`prepare:${input.sessionId}:${input.scope}`)
				return result === 'fail'
					? Effect.fail(
							new GithubCredentialsError({
								sessionId: input.sessionId,
								reason: 'resolve',
								message: 'no',
							}),
						)
					: Effect.succeed(result)
			}),
		release: (sessionId) => Effect.sync(() => calls.push(`release:${sessionId}`)),
	})
	return { calls, layer }
}

describe('readGithubCredentialEnvironment', () => {
	const input = { sessionId: SESSION_ID, taskId: 'task-1', scope: 'sandbox' as const }

	test("holds the session's credential directory for the run's scope, then releases it", async () => {
		const { calls, layer } = recordingCredentials(GITHUB_ENV)
		const githubEnv = await Effect.runPromise(
			Effect.gen(function* () {
				const env = yield* readGithubCredentialEnvironment(input)
				calls.push('run')
				return env
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
		expect(githubEnv).toEqual(GITHUB_ENV)
		expect(calls).toEqual([`prepare:${SESSION_ID}:sandbox`, 'run', `release:${SESSION_ID}`])
	})

	test('releases nothing for a host-login session', async () => {
		const { calls, layer } = recordingCredentials(null)
		await Effect.runPromise(readGithubCredentialEnvironment(input).pipe(Effect.scoped, Effect.provide(layer)))
		expect(calls).toEqual([`prepare:${SESSION_ID}:sandbox`])
	})

	test('fails the preparation, rather than run as the host login, when the account is unavailable', async () => {
		const { calls, layer } = recordingCredentials('fail')
		const exit = await Effect.runPromiseExit(
			readGithubCredentialEnvironment(input).pipe(Effect.scoped, Effect.provide(layer)),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		expect(calls).toEqual([`prepare:${SESSION_ID}:sandbox`])
	})
})

describe('Claude query options with a GitHub account', () => {
	const queryInput = {
		session: makeBasicEffectSession(),
		effectiveSettings: DEFAULT_EFFECTIVE_SETTINGS,
		pathToClaudeCodeExecutable: '/tmp/claude',
		cwd: '/workspace/repo',
		rpiPluginPath: '/tmp/rpi-plugin',
		additionalDirectories: [],
		systemPromptAdditions: [],
		commitAttributionEnv: {
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/hooks',
		},
		inheritedEnv: {
			PATH: '/bin',
			GH_TOKEN: 'host-token',
			GITHUB_TOKEN: 'host-token-2',
			GIT_AUTHOR_NAME: 'Host',
			GIT_COMMITTER_EMAIL: 'host@example.com',
		},
	}

	test('points the agent at the credential directory and strips every override', () => {
		const { env } = buildClaudeQueryOptions({ ...queryInput, githubEnv: GITHUB_ENV })
		expect(env).toMatchObject({ PATH: '/bin', ...GITHUB_ENV, GIT_CONFIG_COUNT: '1' })
		for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL']) {
			expect(env, key).not.toHaveProperty(key)
		}
	})

	test.each([undefined, null])('keeps the inherited env untouched for the host login (%s)', (githubEnv) => {
		const { env } = buildClaudeQueryOptions({ ...queryInput, githubEnv })
		expect(env).toMatchObject(queryInput.inheritedEnv)
		expect(env).not.toHaveProperty('GH_CONFIG_DIR')
		expect(env).not.toHaveProperty('GIT_CONFIG_GLOBAL')
	})
})
