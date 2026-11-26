import type { Task } from '@devflow/db/tables/tasks'
import { ORPCError } from '@orpc/client'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CardAction } from '@/minimalist/lib/card-agent'
import { type DraftLaunch, NEWER_DRAFT_ERROR, toDraftLaunch } from '@/minimalist/lib/launch-form'

import { RESUME_TEXT, RETRY_TEXT, useCardAction } from './use-card-action'

const { api, showToast, projects } = vi.hoisted(() => ({
	api: {
		projects: { v2: { repositorySources: { get: vi.fn(), upsert: vi.fn() } } },
		tasks: { v2: { create: vi.fn() }, launchDraft: vi.fn(), update: vi.fn() },
		ai: { generateTitle: vi.fn() },
		sessions: { interrupt: vi.fn(), relaunch: vi.fn(), v2: { continue: vi.fn() } },
	},
	showToast: vi.fn(),
	projects: { data: [] as Array<{ id: string; name: string; repositories: unknown[]; sandbox?: 'vm' | 'docker' }> },
}))

vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: api }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))
vi.mock('@/minimalist/lib/data', () => ({ useProjects: () => projects }))

const taskId = '019ab7c2-4f1e-7000-8000-00000000d1a7'
const projectId = '019ab7c2-4f1e-7000-8000-0000000000aa'
const repository = {
	remoteUrl: 'git@github.com:acme/app.git',
	repositoryIdentity: 'github.com/acme/app',
	defaultBranch: 'main',
	default: true,
	autoPushBranch: false,
	copyGlobs: [],
}

function snapshot(target: DraftLaunch['target']): DraftLaunch {
	return toDraftLaunch({
		text: 'Retry webhooks with backoff',
		target,
		hostId: 'laptop',
		settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'auto' },
		taskSize: 'unknown',
		smallAutoAdvance: true,
		attachments: [],
	})
}

/** A saved board draft in Todo, as the tasks collection syncs it. */
function draft(launch: unknown): { task: Task } {
	return {
		task: {
			id: taskId,
			name: 'Retry webhooks with backoff',
			slug: 'retry-webhooks-with-backoff-d1a7',
			is_draft: true,
			archived: false,
			status: 'todo',
			project_id: null,
			workspace_id: null,
			ticket_id: null,
			ticket_url: null,
			ticket_provider: null,
			github_connection_id: null,
			ticket_repository_id: null,
			ticket_repository_full_name: null,
			draft_launch: launch,
		} as Task,
	}
}

function render() {
	return renderHook(() => useCardAction()).result
}

async function run(row: { task: Task }, action: NonNullable<CardAction>) {
	const runAction = render().current
	await act(() => runAction(row, action))
}

beforeEach(() => {
	vi.clearAllMocks()
	api.projects.v2.repositorySources.get.mockResolvedValue({ sources: [] })
	api.tasks.v2.create.mockResolvedValue({})
	api.tasks.launchDraft.mockResolvedValue({})
	api.ai.generateTitle.mockResolvedValue({ title: 'Agent title' })
	api.sessions.interrupt.mockResolvedValue({ success: true, transactionId: '1' })
	api.sessions.relaunch.mockResolvedValue({ success: true, transactionId: '1' })
	api.sessions.v2.continue.mockResolvedValue({ kind: 'continued', transactionId: '1' })
	projects.data = [{ id: projectId, name: 'app', repositories: [repository] }]
})

describe("a card's Start", () => {
	it("promotes a directory draft in place, with what it saved, and keeps the draft's column", async () => {
		await run(draft(snapshot({ kind: 'directory', path: '/code/app' })), { kind: 'start' })
		expect(api.tasks.launchDraft).toHaveBeenCalledTimes(1)
		const [input] = api.tasks.launchDraft.mock.calls[0] as [Record<string, unknown>]
		expect(input).toMatchObject({
			draftId: taskId,
			defaultWorkingDirectory: '/code/app',
			firstSession: { hostId: 'laptop', model: 'opus', permissionsMode: 'auto', workingDirectory: '/code/app' },
		})
		// No status goes over the wire, so the server keeps the draft's column.
		expect(input.status).toBeUndefined()
		expect(api.tasks.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() }))
		expect(showToast).not.toHaveBeenCalled()
	})

	it("starts a project draft under the draft's own id, in the project it was saved for", async () => {
		await run(draft(snapshot({ kind: 'project', projectId })), { kind: 'start' })
		const [input] = api.tasks.v2.create.mock.calls[0] as [Record<string, unknown>]
		expect(input).toMatchObject({ taskId, workspaceId: taskId, projectId })
		// No status goes over the wire, so the server keeps the draft's column.
		expect(input.status).toBeUndefined()
		expect(input.sessionId).not.toBe(taskId)
	})

	it.each(['vm', 'docker'] as const)(
		'starts a sized v2 draft with its current project sandbox (%s)',
		async (sandbox) => {
			projects.data = [{ id: projectId, name: 'app', repositories: [repository], sandbox }]
			const sized = {
				...snapshot({ kind: 'project', projectId }),
				version: 2,
				vmScope: 'task',
				vmCpus: 8,
				vmMemoryGiB: 16,
			}
			await run(draft(sized), { kind: 'start' })
			const [input] = api.tasks.v2.create.mock.calls[0] as [Record<string, unknown>]
			expect(input.vmCpus).toBe(sandbox === 'vm' ? 8 : undefined)
			expect(input.vmMemoryGiB).toBe(sandbox === 'vm' ? 16 : undefined)
		},
	)

	it("says why when the draft can't be read, and launches nothing", async () => {
		await run(draft({ version: 3, prompt: 'From the future' }), { kind: 'start' })
		expect(showToast).toHaveBeenCalledWith(NEWER_DRAFT_ERROR)
		expect(api.tasks.launchDraft).not.toHaveBeenCalled()
		expect(api.tasks.v2.create).not.toHaveBeenCalled()
	})

	it("says so when the draft's project is gone", async () => {
		projects.data = []
		await run(draft(snapshot({ kind: 'project', projectId })), { kind: 'start' })
		expect(showToast).toHaveBeenCalledWith("This draft's project isn't available")
		expect(api.tasks.v2.create).not.toHaveBeenCalled()
	})

	it('reports a failed launch once, without throwing', async () => {
		api.tasks.launchDraft.mockRejectedValue(new Error('offline'))
		await run(draft(snapshot({ kind: 'directory', path: '/code/app' })), { kind: 'start' })
		expect(showToast).toHaveBeenCalledWith('Could not start the draft. Try again.')
	})
})

describe("a card's Stop", () => {
	const started = draft(null)

	it('interrupts every session it was given, quietly', async () => {
		await run(started, { kind: 'stop', sessionIds: ['a', 'b'] })
		expect(api.sessions.interrupt).toHaveBeenCalledWith({ sessionId: 'a' }, { context: { silent: true } })
		expect(api.sessions.interrupt).toHaveBeenCalledWith({ sessionId: 'b' }, { context: { silent: true } })
		expect(showToast).not.toHaveBeenCalled()
	})

	it('counts a session that already stopped as stopped', async () => {
		api.sessions.interrupt.mockRejectedValueOnce(new ORPCError('BAD_REQUEST'))
		await run(started, { kind: 'stop', sessionIds: ['a', 'b'] })
		expect(api.sessions.interrupt).toHaveBeenCalledTimes(2)
		expect(showToast).not.toHaveBeenCalled()
	})

	it('shows one toast for the sessions it could not stop, and still stops the rest', async () => {
		api.sessions.interrupt
			.mockRejectedValueOnce(new ORPCError('FORBIDDEN'))
			.mockRejectedValueOnce(new ORPCError('BAD_REQUEST'))
		await run(started, { kind: 'stop', sessionIds: ['a', 'b', 'c'] })
		expect(api.sessions.interrupt).toHaveBeenCalledTimes(3)
		expect(showToast).toHaveBeenCalledTimes(1)
		expect(showToast).toHaveBeenCalledWith('Could not stop 1 of 3 sessions. Try again.')
	})

	it('names the agent when there was only one session to stop', async () => {
		api.sessions.interrupt.mockRejectedValueOnce(new Error('network'))
		await run(started, { kind: 'stop', sessionIds: ['a'] })
		expect(showToast).toHaveBeenCalledWith('Could not stop the agent. Try again.')
	})
})

describe("a card's Resume and Retry", () => {
	const started = draft(null)

	it('Resume sends the standard message, tagged as coming from the card', async () => {
		await run(started, { kind: 'resume', sessionId: 's1' })
		expect(api.sessions.v2.continue).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 's1', text: RESUME_TEXT, intent: 'send', origin: 'card_resume' }),
			{ context: { silent: true } },
		)
		expect(RESUME_TEXT).toBe('Continue where you left off.')
		expect(showToast).not.toHaveBeenCalled()
	})

	it('Retry continues a session whose agent started, tagged as a retry', async () => {
		await run(started, { kind: 'retry', sessionId: 's2', relaunch: false })
		expect(api.sessions.v2.continue).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 's2', text: RETRY_TEXT, intent: 'send', origin: 'card_retry' }),
			{ context: { silent: true } },
		)
		expect(RETRY_TEXT).toBe('Try again.')
		expect(api.sessions.relaunch).not.toHaveBeenCalled()
	})

	it('Retry relaunches a session whose agent never started without sending another message', async () => {
		await run(started, { kind: 'retry', sessionId: 'never-started', relaunch: true })
		expect(api.sessions.relaunch).toHaveBeenCalledExactlyOnceWith(
			{ sessionId: 'never-started' },
			{ context: { silent: true } },
		)
		expect(api.sessions.v2.continue).not.toHaveBeenCalled()
		expect(showToast).not.toHaveBeenCalled()
	})

	it('reports a failed relaunch once without falling back to a continuation message', async () => {
		api.sessions.relaunch.mockRejectedValueOnce(new ORPCError('BAD_REQUEST'))
		await run(started, { kind: 'retry', sessionId: 'never-started', relaunch: true })
		expect(showToast).toHaveBeenCalledExactlyOnceWith('Could not retry the agent. Try again.')
		expect(api.sessions.v2.continue).not.toHaveBeenCalled()
	})

	it('reports a rejected or failed message', async () => {
		api.sessions.v2.continue.mockResolvedValueOnce({ kind: 'rejected', reason: 'forbidden' })
		await run(started, { kind: 'resume', sessionId: 's1' })
		expect(showToast).toHaveBeenCalledWith('Could not resume the agent. Try again.')

		api.sessions.v2.continue.mockRejectedValueOnce(new Error('network'))
		await run(started, { kind: 'retry', sessionId: 's2', relaunch: false })
		expect(showToast).toHaveBeenCalledWith('Could not retry the agent. Try again.')
	})
})
