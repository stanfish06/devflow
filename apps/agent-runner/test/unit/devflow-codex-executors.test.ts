import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { createInterruptState } from '@/agents/shared/interrupt-state.service'
import type { SessionContext } from '@/agents/shared/run-session'
import {
	codexEnvironment,
	executeCodelayerSlot,
	failUnsupportedAgent,
	isCodexAppServerSession,
	startAppServer,
	UNSUPPORTED_AGENT_MESSAGE,
} from '@/devflow/codex-app-server'
import { vmManager } from '@/devflow/vm-sandbox'

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

function installTestAppServer(dir: string) {
	// Record the JSON-RPC requests and echo the user input as an assistant reply.
	writeFileSync(
		join(dir, 'codex'),
		`#!/usr/bin/env node
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
	const { id, method, params } = JSON.parse(line)
	if (id === undefined) return
	require('node:fs').appendFileSync('requests.jsonl', JSON.stringify({ method, params }) + '\\n')
	const send = (message) => console.log(JSON.stringify(message))
	if (method === 'turn/start') {
		send({ id, result: { turn: { id: 'turn' } } })
		send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: params.input.at(-1).text } } })
		send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
	} else {
		send({ id, result: { thread: { id: 'thread' } } })
	}
})
`,
		{ mode: 0o700 },
	)

	vi.stubEnv('PATH', dir + delimiter + process.env.PATH)
	vi.stubEnv('DEVFLOW_AGENT_SANDBOX', 'none')
	vi.stubEnv('DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN', 'true')
}

describe('Codex conversation events', () => {
	test.each([
		{ thread: null, sandbox: 'none', status: 'launching' },
		{ thread: 'existing-thread', sandbox: 'none', status: 'running' },
		{ thread: null, sandbox: 'vm', status: 'ready_for_launch' },
		{ thread: null, sandbox: 'vm', status: 'waiting_for_workspace' },
		{ thread: 'existing-thread', sandbox: 'vm', status: 'running' },
		{ thread: 'existing-thread', sandbox: 'vm', status: 'resuming' },
		{ thread: 'existing-thread', sandbox: 'vm', status: 'interrupt_requested' },
	])('delivers a turn once for thread $thread on $sandbox in $status', async ({ thread, sandbox, status }) => {
		const dir = mkdtempSync(join(tmpdir(), 'devflow-codex-turn-'))
		const release = vi.fn()
		const run = vi.fn(() => ({ child: startAppServer(dir), stop: vi.fn() }))
		const acquire = vi
			.spyOn(vmManager, 'acquire')
			.mockResolvedValue({ name: 'test', uncovered: () => [], run, release })
		try {
			installTestAppServer(dir)
			vi.stubEnv('DEVFLOW_AGENT_SANDBOX', sandbox)
			const create = vi.fn(async () => ({}))
			const prompt = 'a prompt already recorded by the API'
			const ctx = {
				session: {
					id: 'session',
					provider: 'codex',
					working_directory: dir,
					coding_agent_session_id: thread,
					prompt,
				},
				interruptState: {
					wasInterrupted: Effect.succeed(false),
					get: Effect.succeed({ wasInterrupted: false }),
				},
				services: {
					daemonRuntime: { runPromise: vi.fn().mockResolvedValue(null) },
					orpc: { sessions: { update: vi.fn(), events: { create } } },
					collections: {
						sessions: { get: () => ({ status }), subscribeChanges: () => ({ unsubscribe: vi.fn() }) },
					},
				},
			} as unknown as SessionContext
			const turn = executeCodelayerSlot(ctx, thread ? 'session' : undefined)
			if (status === 'interrupt_requested') {
				await expect(turn).rejects.toThrow('session stopped')
				expect(run).not.toHaveBeenCalled()
				expect(release).toHaveBeenCalledOnce()
				return
			}
			await turn
			if (sandbox === 'vm') {
				expect(run).toHaveBeenCalledOnce()
				expect(release).toHaveBeenCalledOnce()
			}
			expect(create).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ eventType: 'message', role: 'assistant', content: prompt }),
			)
		} finally {
			acquire.mockRestore()
			vi.unstubAllEnvs()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

test('loads the bundled research skill, routes it to PRD and uploads the artifact before auto-advance', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'devflow-codex-research-'))
	try {
		installTestAppServer(dir)
		vi.stubEnv('HOME', dir)
		const task = { id: 'task', slug: 'sample', workflow_type: 'prd_tdd', worktree_timing: 'now', sandbox: 'none' }
		const prompt = 'use the rpi:create-research skill for .devflow/tasks/sample'
		const create = vi.fn(async () => ({}))
		const upsertArtifact = vi.fn(async () => ({ artifactId: 'artifact' }))
		const update = vi.fn(async ({ status }: { status?: string }) => {
			if (status === 'running') {
				// Simulate the file on disk at turn completion, written through the task symlink.
				writeFileSync(join(dir, '.devflow/tasks/sample/research.md'), '---\ntype: research\n---\nfindings')
			}
			if (status === 'ready_for_input') expect(upsertArtifact).toHaveBeenCalledOnce()
		})
		const ctx = {
			session: { id: 'session', provider: 'codex', task_id: task.id, working_directory: dir, prompt },
			interruptState: { wasInterrupted: Effect.succeed(false), get: Effect.succeed({ wasInterrupted: false }) },
			services: {
				collections: {
					tasks: { get: () => task },
					sessions: { subscribeChanges: () => ({ unsubscribe: vi.fn() }) },
				},
				orpc: { sessions: { update, events: { create } } },
				daemonRuntime: { runPromise: vi.fn().mockResolvedValue(null) },
				syncService: {
					ensureTaskSync: async () => ({
						createSessionManager: () => ({ upsertArtifact, getCollection: () => undefined }),
					}),
				},
			},
		} as unknown as SessionContext
		await executeCodelayerSlot(ctx)
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: 'Skill', toolInputJson: { skill: 'rpi:create-research' } }),
		)
		expect(upsertArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ fileName: 'research.md', frontmatter: { type: 'research' } }),
		)
		expect(update).toHaveBeenCalledWith({ sessionId: 'session', status: 'ready_for_input' })
		const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		const settings = requests.find((request) => request.method === 'thread/start').params
		expect(settings.config.sandbox_workspace_write.writable_roots).toEqual([join(dir, '.devflow/artifacts/task')])
		const input = requests.find((request) => request.method === 'turn/start').params.input
		expect(input.at(-1).text).toBe(prompt)
		expect(input[0].text).toContain('skills/create-research/references/research_template.md')
		expect(input[0].text).toContain('suggest /rpi:create-prd')
	} finally {
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	}
})

test.each([
	{ skill: 'create-prd', label: 'rpi:design-prd', reply: 'Yes, that describes the problem.' },
	{ skill: 'iterate-tdd', label: 'rpi:design-tdd', reply: 'Proceed with the second option.' },
])('reactivates $skill with the prior decision on a plain-text reply', async ({ skill, label, reply }) => {
	const dir = mkdtempSync(join(tmpdir(), 'devflow-codex-followup-'))
	try {
		installTestAppServer(dir)
		const history = [
			{ role: 'user', content: 'Only librarians can release a hold.' },
			{ role: 'assistant', content: 'Should volunteers be able to see the queue?' },
		]
		const workflowSkill = vi.fn(async () => ({ skill, conversation: history }))
		const create = vi.fn(async () => ({}))
		const ctx = {
			session: {
				id: 'session',
				provider: 'codex',
				working_directory: dir,
				coding_agent_session_id: 'thread',
				labels: [{ name: label, title: 'design' }],
				prompt: reply,
			},
			interruptState: await createInterruptState(),
			services: {
				daemonRuntime: { runPromise: vi.fn().mockResolvedValue(null) },
				orpc: { sessions: { update: vi.fn(), workflowSkill, events: { create } } },
				collections: { sessions: { subscribeChanges: () => ({ unsubscribe: vi.fn() }) } },
			},
		} as unknown as SessionContext
		await executeCodelayerSlot(ctx, 'session')
		expect(workflowSkill).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session' })
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: 'Skill', toolInputJson: { skill: `rpi:${skill}` } }),
		)
		const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(requests.find((row) => row.method === 'thread/resume').params.threadId).toBe('thread')
		const input = requests.find((row) => row.method === 'turn/start').params.input
		expect(input).toHaveLength(2)
		expect(input[0].text).toContain(`skills/${skill}/SKILL.md`)
		expect(input[0].text).toContain(JSON.stringify(history))
		expect(input[1].text).toBe(reply)
		expect(create).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'message', role: 'user' }))
	} finally {
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('Stop during artifact upload skips the remaining files and the workflow ready transition', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'devflow-codex-stop-'))
	try {
		installTestAppServer(dir)
		vi.stubEnv('HOME', dir)
		const task = { id: 'task', slug: 'sample', sandbox: 'none' }
		const stop = [{ type: 'update', value: { id: 'session', status: 'interrupt_requested' } }] as const
		let sendStop: () => Promise<void> = async () => {
			throw new Error('Missing interrupt subscription')
		}
		const upsertArtifact = vi.fn(async () => {
			await sendStop()
			return { artifactId: 'artifact' }
		})
		const update = vi.fn(async ({ status }: { status?: string }) => {
			if (status === 'running') {
				for (const name of ['research.md', 'notes.md']) {
					writeFileSync(join(dir, '.devflow/tasks', task.slug, name), name)
				}
			}
		})
		const ctx = {
			session: { id: 'session', provider: 'codex', task_id: task.id, working_directory: dir, prompt: 'research' },
			interruptState: await createInterruptState(),
			services: {
				collections: {
					tasks: { get: () => task },
					sessions: {
						subscribeChanges: (callback: (changes: typeof stop) => Promise<void>) => {
							sendStop = () => callback(stop)
							return { unsubscribe: vi.fn() }
						},
					},
				},
				shutdown: { isDaemonShuttingDown: () => false },
				orpc: { sessions: { update, events: { create: vi.fn() } } },
				daemonRuntime: { runPromise: vi.fn().mockResolvedValue(null) },
				syncService: {
					ensureTaskSync: async () => ({
						createSessionManager: () => ({ upsertArtifact, getCollection: () => undefined }),
					}),
				},
			},
		} as unknown as SessionContext
		await executeCodelayerSlot(ctx)
		expect(update).not.toHaveBeenCalledWith({ sessionId: 'session', status: 'ready_for_input' })
		expect(update).toHaveBeenCalledWith({ sessionId: 'session', status: 'interrupted' })
		expect(upsertArtifact).toHaveBeenCalledOnce()
	} finally {
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	}
})
