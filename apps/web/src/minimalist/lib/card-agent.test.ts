import type { SessionStatus } from '@devflow/db/tables/sessions'
import { describe, expect, it } from 'vitest'

import { type CardState, cardAgent } from '@/minimalist/lib/card-agent'

type FakeSession = {
	id: string
	status: SessionStatus
	archived: boolean
	coding_agent_session_id: string | null
	last_activity_at: bigint | null
	updated_at: bigint
	created_at: bigint
}

/** A session last active at `at` (ms), with a coding agent session unless it never started. */
function session(id: string, status: SessionStatus, at = 1_000, patch: Partial<FakeSession> = {}): FakeSession {
	return {
		id,
		status,
		archived: false,
		coding_agent_session_id: `agent-${id}`,
		last_activity_at: BigInt(at),
		updated_at: BigInt(at),
		created_at: BigInt(0),
		...patch,
	}
}

function row(sessions: FakeSession[], patch: { is_draft?: boolean; attention?: 'failed' | 'running' } = {}) {
	return { task: { is_draft: patch.is_draft ?? false }, sessions, attention: patch.attention }
}

describe('cardAgent', () => {
	it('is a Draft with Start before anything launched', () => {
		expect(cardAgent(row([], { is_draft: true }))).toEqual({ state: 'draft', action: { kind: 'start' } })
	})

	it.each<[SessionStatus, CardState]>([
		['needs_approval', 'needs-you'],
		['failed', 'failed'],
		['lost', 'failed'],
		['ready_for_launch', 'running'],
		['waiting_for_workspace', 'running'],
		['launching', 'running'],
		['running', 'running'],
		['resuming', 'running'],
		['waiting_for_usage_limit', 'running'],
		['interrupt_requested', 'running'],
		['interrupted', 'stopped'],
		['ready_for_input', 'finished'],
	])('reads a %s session as %s', (status, state) => {
		expect(cardAgent(row([session('s', status)])).state).toBe(state)
	})

	it.each<[SessionStatus[], CardState]>([
		[['ready_for_input', 'interrupted', 'running', 'failed', 'needs_approval'], 'needs-you'],
		[['ready_for_input', 'interrupted', 'running', 'lost'], 'failed'],
		[['ready_for_input', 'interrupted', 'running'], 'running'],
		[['ready_for_input', 'interrupted'], 'stopped'],
		[['ready_for_input', 'ready_for_input'], 'finished'],
	])('ranks %j as %s: Needs you > Failed > Running > Stopped > Finished', (statuses, state) => {
		const sessions = statuses.map((status, index) => session(`s${index}`, status, 1_000 + index))
		expect(cardAgent(row(sessions)).state).toBe(state)
	})

	it('stops every session that is working, but not queued or already stopping ones', () => {
		const agent = cardAgent(
			row([
				session('a', 'running'),
				session('b', 'resuming'),
				session('c', 'launching'),
				session('d', 'waiting_for_usage_limit'),
				session('queued', 'ready_for_launch'),
				session('stopping', 'interrupt_requested'),
				session('idle', 'ready_for_input'),
				session('stopped', 'interrupted'),
			]),
		)
		expect(agent).toEqual({ state: 'running', action: { kind: 'stop', sessionIds: ['a', 'b', 'c', 'd'] } })
	})

	it('shows Running without Stop while every working session is queued or already stopping', () => {
		expect(
			cardAgent(row([session('queued', 'ready_for_launch'), session('stopping', 'interrupt_requested')])),
		).toEqual({ state: 'running', action: null })
	})

	it('resumes the most recently active stopped session', () => {
		const agent = cardAgent(
			row([
				session('older', 'interrupted', 1_000),
				session('newest', 'interrupted', 3_000),
				session('finished', 'ready_for_input', 5_000),
				session('middle', 'interrupted', 2_000),
			]),
		)
		expect(agent).toEqual({ state: 'stopped', action: { kind: 'resume', sessionId: 'newest' } })
	})

	it('retries the most recently active failed or stalled session, relaunching one whose agent never started', () => {
		expect(
			cardAgent(
				row([session('failed', 'failed', 1_000), session('lost', 'lost', 2_000), session('i', 'interrupted')]),
			).action,
		).toEqual({ kind: 'retry', sessionId: 'lost', relaunch: false })
		expect(cardAgent(row([session('never', 'failed', 4_000, { coding_agent_session_id: null })])).action).toEqual({
			kind: 'retry',
			sessionId: 'never',
			relaunch: true,
		})
	})

	it('reads activity from the latest of last activity, update and creation', () => {
		const agent = cardAgent(
			row([
				session('touched', 'interrupted', 1_000, { updated_at: BigInt(9_000) }),
				session('active', 'interrupted', 5_000),
			]),
		)
		expect(agent.action).toEqual({ kind: 'resume', sessionId: 'touched' })
	})

	it('offers nothing for Needs you or Finished: the card opens the thread', () => {
		expect(cardAgent(row([session('s', 'needs_approval'), session('r', 'running')]))).toEqual({
			state: 'needs-you',
			action: null,
		})
		expect(cardAgent(row([session('s', 'ready_for_input')]))).toEqual({ state: 'finished', action: null })
	})

	it('ignores archived sessions, and session drafts that never launched', () => {
		const agent = cardAgent(
			row([
				session('gone', 'running', 1_000, { archived: true }),
				session('draft', 'draft'),
				session('i', 'interrupted'),
			]),
		)
		expect(agent).toEqual({ state: 'stopped', action: { kind: 'resume', sessionId: 'i' } })
		expect(cardAgent(row([session('gone', 'failed', 1_000, { archived: true })]))).toEqual({
			state: 'finished',
			action: null,
		})
	})

	it('shows a workspace whose setup failed as Failed, retried from the task rather than the card', () => {
		expect(cardAgent(row([session('w', 'waiting_for_workspace')], { attention: 'failed' }))).toEqual({
			state: 'failed',
			action: null,
		})
	})

	it('is a Draft even if a legacy draft has sessions', () => {
		expect(cardAgent(row([session('s', 'running')], { is_draft: true })).state).toBe('draft')
	})

	it('still offers Stop for a working session when workspace setup also failed', () => {
		expect(
			cardAgent(row([session('w', 'waiting_for_workspace'), session('r', 'running')], { attention: 'failed' })),
		).toEqual({
			state: 'running',
			action: { kind: 'stop', sessionIds: ['r'] },
		})
	})
})
