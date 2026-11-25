import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
	type CleanOptions,
	decideWorkspace,
	isDisposable,
	loadTasks,
	nodeModulesUnder,
	parseCleanArgs,
	type TaskFacts,
	type WorkspaceFacts,
	type WorktreeFacts,
} from '../lib/clean'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const options: CleanOptions = { apply: false, force: false, idleDays: 7, logDays: 14, useGh: false }
const clean: WorktreeFacts = {
	path: '/w/repo',
	dirty: false,
	unpushed: false,
	merged: false,
	localFiles: [],
	unknown: null,
}
const liveTask: TaskFacts = {
	id: 'task',
	archived: false,
	status: 'in_progress',
	active: false,
	lastActivityMs: NOW - DAY,
}
const workspace = (overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
	path: '/w',
	task: liveTask,
	worktrees: [clean],
	modifiedMs: NOW - DAY,
	...overrides,
})
const decide = (overrides: Partial<WorkspaceFacts>, opts: Partial<CleanOptions> = {}) =>
	decideWorkspace(workspace(overrides), { ...options, ...opts }, NOW)

describe('decideWorkspace', () => {
	it('removes the worktrees of archived, done and merged tasks', () => {
		expect(decide({ task: { ...liveTask, archived: true } })).toMatchObject({
			action: 'remove',
			reason: 'task archived',
		})
		expect(decide({ task: { ...liveTask, status: 'done' } }).action).toBe('remove')
		expect(decide({ worktrees: [{ ...clean, merged: true }] })).toMatchObject({
			action: 'remove',
			reason: 'branch merged',
		})
	})

	it('never removes a workspace whose task it cannot pin down', () => {
		expect(decide({ task: null })).toMatchObject({ action: 'keep', reason: 'no task row' })
		expect(decide({ task: 'ambiguous' }, { force: true }).action).toBe('keep')
	})

	it('never touches a task whose session is at work', () => {
		expect(
			decide({ task: { ...liveTask, archived: true, active: true, lastActivityMs: 0 } }, { force: true }).action,
		).toBe('keep')
	})

	it('keeps uncommitted, unpushed, local or unverifiable work unless forced', () => {
		const done = { ...liveTask, status: 'done' }
		expect(decide({ task: done, worktrees: [{ ...clean, dirty: true }] })).toMatchObject({
			action: 'keep',
			reason: 'task done, but uncommitted changes',
		})
		expect(decide({ task: { ...done, archived: true }, worktrees: [{ ...clean, unpushed: true }] }).action).toBe(
			'keep',
		)
		expect(decide({ task: done, worktrees: [{ ...clean, localFiles: ['.env.local'] }] }).reason).toContain(
			'.env.local',
		)
		expect(decide({ task: done, worktrees: [{ ...clean, unknown: 'could not fetch origin' }] }).reason).toContain(
			'could not fetch',
		)
		expect(decide({ task: done, worktrees: [{ ...clean, dirty: true }] }, { force: true }).action).toBe('remove')
	})

	it('drops only node_modules of an idle workspace, judged by the newer of sessions and files', () => {
		expect(
			decide({ task: { ...liveTask, lastActivityMs: NOW - 8 * DAY }, modifiedMs: NOW - 8 * DAY }),
		).toMatchObject({
			action: 'deps',
			reason: 'idle 8 days',
		})
		// Edited by hand yesterday, though its last session was weeks ago.
		expect(decide({ task: { ...liveTask, lastActivityMs: NOW - 30 * DAY }, modifiedMs: NOW - DAY }).action).toBe(
			'keep',
		)
		expect(decide({ task: null, modifiedMs: NOW - 9 * DAY })).toMatchObject({
			action: 'deps',
			reason: 'no task row',
		})
	})
})

describe('loadTasks', () => {
	it('reads tasks by slug and workspace id, and marks names two tasks claim', () => {
		const rows = [
			{
				slug: 'a',
				workspace_id: 'ws-a',
				id: 'id-a',
				archived: true,
				status: 'in_progress',
				active: false,
				last_activity: 1000,
			},
			{
				slug: null,
				workspace_id: 'ws-b',
				id: 'id-b',
				archived: false,
				status: 'done',
				active: null,
				last_activity: null,
			},
			{
				slug: 'ws-b',
				workspace_id: 'ws-c',
				id: 'id-c',
				archived: false,
				status: 'in_progress',
				active: true,
				last_activity: '5',
			},
		]
		const tasks = loadTasks(() => JSON.stringify(rows))
		expect(tasks.get('a')).toEqual({
			id: 'id-a',
			archived: true,
			status: 'in_progress',
			active: false,
			lastActivityMs: 1000,
		})
		expect(tasks.get('ws-a')).toEqual(tasks.get('a'))
		expect(tasks.get('ws-b')).toBe('ambiguous')
		expect(tasks.get('ws-c')).toMatchObject({ id: 'id-c', active: true, lastActivityMs: 5 })
	})
})

describe('disposable files', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'clean-'))
	afterAll(() => rmSync(scratch, { recursive: true, force: true }))

	it('treats build output and devflow data as disposable, other ignored files as local work', () => {
		for (const path of [
			'node_modules/',
			'apps/web/dist/',
			'vendor/x/tsconfig.tsbuildinfo',
			'.shadow/abc/HEAD',
			'.devflow/tasks/t',
		]) {
			expect(isDisposable(path), path).toBe(true)
		}
		for (const path of ['.env.local', 'notes/todo.md', 'apps/web/.env'])
			expect(isDisposable(path), path).toBe(false)
	})

	it('finds node_modules directories without descending into them, whatever their parents are named', () => {
		const odd = join(scratch, 'pkg\nwith newline')
		mkdirSync(join(odd, 'node_modules', 'dep', 'node_modules'), { recursive: true })
		mkdirSync(join(scratch, 'node_modules'), { recursive: true })
		expect(nodeModulesUnder(scratch).sort()).toEqual(
			[join(scratch, 'node_modules'), join(odd, 'node_modules')].sort(),
		)
	})
})

describe('parseCleanArgs', () => {
	it('reads the flags', () => {
		expect(parseCleanArgs(['--yes', '--days', '3', '--no-gh'])).toMatchObject({
			apply: true,
			idleDays: 3,
			useGh: false,
			force: false,
		})
		expect(parseCleanArgs(['--days', 'x'])).toMatchObject({ apply: false, idleDays: 7, useGh: true })
	})
})
