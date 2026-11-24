import { describe, expect, test, vi } from 'vitest'

import type { SessionContext } from '@/agents/shared/run-session'
import {
	codexEnvironment,
	executeCodelayerSlot,
	failUnsupportedAgent,
	isCodexAppServerSession,
	UNSUPPORTED_AGENT_MESSAGE,
} from '@/devflow/codex-app-server'

/** Only `session.id`, `session.provider` and `orpc.sessions.update` are read on the fail-fast path. */
function contextFor(provider: string | null) {
	const update = vi.fn(async () => ({}))
	const ctx = {
		session: { id: 'session-1', provider },
		services: { orpc: { sessions: { update } } },
	} as unknown as SessionContext
	return { ctx, update }
}

describe('devflow agent executors', () => {
	test('only Codex sessions run on the app-server', () => {
		expect(isCodexAppServerSession({ provider: 'codex' })).toBe(true)
		expect(isCodexAppServerSession({ provider: 'xai' })).toBe(false)
		expect(isCodexAppServerSession({ provider: null })).toBe(false)
	})

	test('a CodeLayer session with another provider fails without starting an agent', async () => {
		const { ctx, update } = contextFor('xai')
		await executeCodelayerSlot(ctx)
		expect(update).toHaveBeenCalledExactlyOnceWith({
			sessionId: 'session-1',
			status: 'failed',
			errorMessage: UNSUPPORTED_AGENT_MESSAGE,
		})
	})

	test('a Fold session fails with the same message', async () => {
		const { ctx, update } = contextFor(null)
		await failUnsupportedAgent(ctx)
		expect(update).toHaveBeenCalledExactlyOnceWith({
			sessionId: 'session-1',
			status: 'failed',
			errorMessage: 'devflow runs Claude Code and Codex (codex app-server) only',
		})
	})

	test('a Codex run with a GitHub account gets the credential pointers and no host token or identity', () => {
		const githubEnv = { GH_CONFIG_DIR: '/run/s/github/gh', GIT_CONFIG_GLOBAL: '/run/s/github/gitconfig' }
		const host = { PATH: '/bin', CODEX_HOME: '/home/me/.codex', GH_TOKEN: 'host', GIT_AUTHOR_EMAIL: 'me@x' }
		expect(codexEnvironment(githubEnv, host)).toEqual({ PATH: '/bin', CODEX_HOME: '/home/me/.codex', ...githubEnv })
		expect(codexEnvironment(null, host)).toEqual(host)
	})
})
