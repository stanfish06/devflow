/**
 * `bun run devflow clean`: free disk under DEVFLOW_HOME (task worktrees and their dependency
 * installs, old logs) and the agent VMs of finished tasks.
 *
 * For each task workspace under ~/.devflow/workspaces:
 * - remove: its task is archived, done or canceled, or every branch in it is merged (its own commits
 *   are in the remote's default branch, or GitHub reports the pull request for exactly this commit
 *   merged). Worktrees are removed with `git worktree remove` (branches stay), then the workspace
 *   directory if nothing else is left in it, and the task's VM.
 * - deps: anything else idle for `--days` (default 7) loses its git-ignored node_modules.
 * - keep: never touched when a session is at work, the task is unknown or ambiguous, or (without
 *   `--force`) a worktree has uncommitted changes, commits no remote has, local files git ignores
 *   that are not build output, or git could not answer.
 * Every target is checked again right before it is deleted. Without `--yes` it only reports (it
 * still fetches each repository's remote, to know what is merged and pushed).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'

export interface CleanOptions {
	readonly apply: boolean
	readonly force: boolean
	/** Idle days before a kept worktree loses its node_modules. */
	readonly idleDays: number
	readonly logDays: number
	/** Ask GitHub (`gh`) whether a branch's pull request is merged. */
	readonly useGh: boolean
}

export function parseCleanArgs(args: readonly string[]): CleanOptions {
	const number = (flag: string, fallback: number) => {
		const index = args.indexOf(flag)
		const value = index >= 0 ? Number(args[index + 1]) : Number.NaN
		return Number.isFinite(value) && value >= 0 ? value : fallback
	}
	return {
		apply: args.includes('--yes'),
		force: args.includes('--force'),
		idleDays: number('--days', 7),
		logDays: number('--log-days', 14),
		useGh: !args.includes('--no-gh'),
	}
}

/** The daemon's active session states (packages/db DAEMON_ACTIVE_SESSION_STATUSES) plus a pending stop. */
export const ACTIVE_SESSION_STATUSES = [
	'launching',
	'running',
	'needs_approval',
	'waiting_for_usage_limit',
	'resuming',
	'interrupt_requested',
] as const

/** What the database knows of a workspace's task. */
export interface TaskFacts {
	readonly id: string
	readonly archived: boolean
	readonly status: string
	readonly active: boolean
	/** Newest session activity (ms), or null without sessions. */
	readonly lastActivityMs: number | null
}

export interface WorktreeFacts {
	readonly path: string
	readonly dirty: boolean
	/** Commits that no (freshly fetched) remote has. */
	readonly unpushed: boolean
	readonly merged: boolean
	/** Git-ignored files that are not build output or devflow's own (a hand-made .env.local). */
	readonly localFiles: readonly string[]
	/** Why git could not tell; such a worktree is never removed without `--force`. */
	readonly unknown: string | null
}

export interface WorkspaceFacts {
	readonly path: string
	/** null: no task row; 'ambiguous': more than one task names this workspace. */
	readonly task: TaskFacts | null | 'ambiguous'
	readonly worktrees: readonly WorktreeFacts[]
	/** Newest change on disk (ms). */
	readonly modifiedMs: number
}

export type CleanAction = 'remove' | 'deps' | 'keep'

export interface CleanDecision {
	readonly action: CleanAction
	readonly reason: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Why a worktree must not be removed without `--force`, or null. */
function unsafeReason(worktrees: readonly WorktreeFacts[]): string | null {
	for (const worktree of worktrees) {
		if (worktree.unknown) return worktree.unknown
		if (worktree.dirty) return 'uncommitted changes'
		if (worktree.unpushed && !worktree.merged) return 'unpushed commits'
		if (worktree.localFiles.length > 0) return `local files (${worktree.localFiles.slice(0, 3).join(', ')})`
	}
	return null
}

/** The cleanup rule for one task workspace; see the module comment. */
export function decideWorkspace(workspace: WorkspaceFacts, options: CleanOptions, nowMs: number): CleanDecision {
	const task = workspace.task
	if (task === 'ambiguous') return { action: 'keep', reason: 'several tasks name this workspace' }
	if (task?.active) return { action: 'keep', reason: 'a session is at work' }
	const unsafe = options.force ? null : unsafeReason(workspace.worktrees)

	const finished = (() => {
		if (task === null) return null
		if (task.archived) return 'task archived'
		if (task.status === 'done' || task.status === 'canceled') return `task ${task.status}`
		const merged = workspace.worktrees.length > 0 && workspace.worktrees.every((worktree) => worktree.merged)
		return merged ? 'branch merged' : null
	})()
	if (finished && !unsafe) return { action: 'remove', reason: finished }

	// The newer of session activity and files touched by hand.
	const lastUse = Math.max(task?.lastActivityMs ?? 0, workspace.modifiedMs)
	const idleDays = Math.max(0, Math.floor((nowMs - lastUse) / DAY_MS))
	const why = finished ? `${finished}, but ${unsafe}` : task === null ? 'no task row' : null
	if (idleDays >= options.idleDays) return { action: 'deps', reason: why ?? `idle ${idleDays} days` }
	return { action: 'keep', reason: why ?? `used ${idleDays} days ago` }
}

// Inherited repository overrides would point every git call at some other checkout.
const gitEnv = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'].includes(key),
		),
	)

const run = (command: string, args: readonly string[], cwd?: string) =>
	spawnSync(command, args, {
		cwd,
		env: gitEnv(),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
	})

/** Directories under a task workspace that are git worktrees: the workspace itself, or its repositories. */
export function worktreesOf(workspace: string): string[] {
	if (existsSync(join(workspace, '.git'))) return [workspace]
	return readdirSync(workspace, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(workspace, entry.name, '.git')))
		.map((entry) => join(workspace, entry.name))
}

/** Git-ignored entries that a build or devflow recreates; anything else ignored is someone's data. */
const DISPOSABLE = new Set([
	'node_modules',
	'dist',
	'build',
	'.turbo',
	'.next',
	'.cache',
	'coverage',
	'test-results',
	'playwright-report',
	'.devflow',
	'.shadow',
	'target',
	'.venv',
	'__pycache__',
])
export const isDisposable = (path: string) =>
	path
		.replace(/\/$/, '')
		.split('/')
		.some((segment) => DISPOSABLE.has(segment)) || path.endsWith('.tsbuildinfo')

/** A worktree whose .git points at metadata that no longer exists. */
export const BROKEN_WORKTREE = 'git metadata missing (broken worktree)'

const fetched = new Map<string, boolean>()

export function worktreeFacts(path: string, useGh: boolean): WorktreeFacts {
	const git = (...args: string[]) => run('git', args, path)
	const base = { path, dirty: false, unpushed: false, merged: false, localFiles: [] as string[] }
	const unknown = (why: string): WorktreeFacts => ({ ...base, unknown: why })

	const top = git('rev-parse', '--show-toplevel')
	if (top.status !== 0) return unknown(BROKEN_WORKTREE)
	if (top.stdout.trim() !== path) return unknown('not a git worktree root')
	const status = git(
		'status',
		'--porcelain=v1',
		'-z',
		'--ignored',
		'--untracked-files=normal',
		'--ignore-submodules=none',
	)
	// Untracked and ignored directories come back collapsed (node_modules/), not file by file.
	if (status.status !== 0) return unknown('git status failed')
	const entries = status.stdout.split('\0').filter(Boolean)
	const dirty = entries.some((entry) => !entry.startsWith('!! '))
	const localFiles = entries
		.filter((entry) => entry.startsWith('!! '))
		.map((entry) => entry.slice(3))
		.filter((file) => !isDisposable(file))

	// "Pushed" and "merged" are judged against the remote as it is now.
	const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim()
	if (!fetched.has(common)) fetched.set(common, git('fetch', '--quiet', '--prune', 'origin').status === 0)
	if (!fetched.get(common)) return { ...base, dirty, localFiles, unknown: 'could not fetch origin' }
	const unpushedCount = git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
	if (unpushedCount.status !== 0) return { ...base, dirty, localFiles, unknown: 'git rev-list failed' }
	const unpushed = Number(unpushedCount.stdout.trim()) > 0

	// The server's default branch, not a possibly stale local origin/HEAD.
	const symref = git('ls-remote', '--symref', 'origin', 'HEAD').stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1]
	const head = git('rev-parse', 'HEAD').stdout.trim()
	const branch = git('branch', '--show-current').stdout.trim()
	// A fresh branch with no commits of its own already sits in the default branch's history, so
	// merged needs work since the branch was created (its oldest reflog entry) that landed there.
	const createdAt = branch
		? git('reflog', 'show', '--format=%H', `refs/heads/${branch}`).stdout.trim().split('\n').at(-1)
		: undefined
	const ownCommits = createdAt ? Number(git('rev-list', '--count', `${createdAt}..HEAD`).stdout.trim() || '0') : 0
	let merged =
		Boolean(symref) && ownCommits > 0 && git('merge-base', '--is-ancestor', 'HEAD', `origin/${symref}`).status === 0
	// Squash and rebase merges leave the branch off the default branch; GitHub knows, for this exact commit.
	if (!merged && useGh && branch && head) {
		const prs = run(
			'gh',
			['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--limit', '20'],
			path,
		)
		if (prs.status === 0) {
			try {
				merged = (JSON.parse(prs.stdout) as Array<{ headRefOid?: string }>).some((pr) => pr.headRefOid === head)
			} catch {
				merged = false
			}
		}
	}
	return { path, dirty, unpushed, merged, localFiles, unknown: null }
}

/** Newest mtime among the workspace's and its worktrees' top-level entries (skips walking deep trees). */
function modifiedMs(workspace: string, worktrees: readonly string[]): number {
	let newest = statSync(workspace).mtimeMs
	for (const dir of [workspace, ...worktrees]) {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules') continue
			try {
				newest = Math.max(newest, lstatSync(join(dir, entry)).mtimeMs)
			} catch {
				// Gone meanwhile: not a sign of use.
			}
		}
	}
	return newest
}

export type DatabaseQuery = (sql: string) => string

interface TaskRow {
	slug: string | null
	workspace_id: string | null
	id: string
	archived: boolean
	status: string
	active: boolean | null
	last_activity: number | string | null
}

/** Tasks by workspace directory name (a task's slug, or its workspace id when the slug is unsafe). */
export function loadTasks(query: DatabaseQuery): Map<string, TaskFacts | 'ambiguous'> {
	const active = ACTIVE_SESSION_STATUSES.map((status) => `'${status}'`).join(', ')
	const json = query(
		[
			"select coalesce(json_agg(row_to_json(r)), '[]') from (",
			'select t.slug, t.workspace_id, t.id, t.archived, t.status,',
			`bool_or(s.status in (${active})) as active, max(s.last_activity_at) as last_activity`,
			'from tasks t left join sessions s on s.task_id = t.id group by t.id) r',
		].join(' '),
	).trim()
	const rows = JSON.parse(json) as TaskRow[]
	if (!Array.isArray(rows)) throw new Error('Unexpected task listing from Postgres')
	const tasks = new Map<string, TaskFacts | 'ambiguous'>()
	for (const row of rows) {
		const facts: TaskFacts = {
			id: row.id,
			archived: row.archived,
			status: row.status,
			active: row.active === true,
			lastActivityMs: row.last_activity === null ? null : Number(row.last_activity),
		}
		for (const name of new Set([row.slug, row.workspace_id].filter((value): value is string => !!value))) {
			const existing = tasks.get(name)
			tasks.set(
				name,
				existing === undefined || (existing !== 'ambiguous' && existing.id === facts.id) ? facts : 'ambiguous',
			)
		}
	}
	return tasks
}

export interface CleanItem {
	readonly label: string
	readonly bytes: number
	readonly decision: CleanDecision
	/** Re-checks the target, then deletes it; the failure, or null when done. */
	readonly apply: () => string | null
}

/** Bytes used by `paths` (du -sk is in POSIX; -b is GNU only). */
const diskUsage = (paths: readonly string[]) => {
	if (paths.length === 0) return 0
	const result = run('du', ['-skc', ...paths])
	const total = Number(result.stdout.trim().split('\n').at(-1)?.split('\t')[0])
	return Number.isFinite(total) ? total * 1024 : 0
}

/** node_modules directories under `root`, not descending into them (no shell, so any file name works). */
export function nodeModulesUnder(root: string): string[] {
	const found: string[] = []
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const path = join(dir, entry.name)
			if (entry.name === 'node_modules') found.push(path)
			else if (entry.name !== '.git') walk(path)
		}
	}
	walk(root)
	return found
}

/** Lima VM name of a task's own VM (apps/agent-runner/src/devflow/vm-sandbox.ts taskVmName). */
export const taskVmName = (taskId: string) => `devflow-task-${taskId.replace(/-/g, '').slice(-12).toLowerCase()}`

function deleteVm(name: string): string | null {
	const result = run('limactl', ['--tty=false', 'delete', '--force', name])
	return result.status === 0
		? null
		: `limactl delete ${name}: ${(result.stderr ?? result.error?.message ?? '').trim()}`
}

/** Remove the worktrees via git (never by force-deleting what git refused), then the folder if empty. */
function removeWorktrees(workspace: string, worktrees: readonly WorktreeFacts[]): string | null {
	for (const worktree of worktrees) {
		// Only reached with --force: git has nothing to say about it, so its folder goes as is.
		if (worktree.unknown === BROKEN_WORKTREE) {
			rmSync(worktree.path, { recursive: true, force: true })
			continue
		}
		const common = run(
			'git',
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			worktree.path,
		).stdout.trim()
		if (!common) return `${worktree.path}: not a git worktree`
		const removed = run('git', ['--git-dir', common, 'worktree', 'remove', '--force', worktree.path])
		if (removed.status !== 0) return `git worktree remove ${worktree.path}: ${removed.stderr.trim()}`
	}
	const left = existsSync(workspace) ? readdirSync(workspace) : []
	if (left.length > 0) return `kept ${workspace}: it still holds ${left.slice(0, 3).join(', ')}`
	rmSync(workspace, { recursive: true, force: true })
	return null
}

/** Everything `clean` would do, measured; `apply` on each item re-checks and does it. */
export function planClean(input: {
	readonly devflowHome: string
	readonly options: CleanOptions
	readonly query: DatabaseQuery
	readonly nowMs?: number
	readonly limaHome?: string
}): CleanItem[] {
	const { devflowHome, options, query } = input
	const nowMs = input.nowMs ?? Date.now()
	const tasks = loadTasks(query)
	const limaHome = input.limaHome ?? process.env.LIMA_HOME ?? join(homedir(), '.lima')
	const vms = existsSync(limaHome) ? readdirSync(limaHome).filter((name) => name.startsWith('devflow-task-')) : []
	const items: CleanItem[] = []
	/** Tasks a workspace was decided for: the VM pass leaves them to that decision. */
	const decidedTasks = new Set<string>()

	const recheck = (workspace: string, action: CleanAction) => {
		const fresh = planWorkspace(workspace)
		return fresh.decision.action === action
			? null
			: `skipped ${basename(workspace)}: now ${fresh.decision.action} (${fresh.decision.reason})`
	}
	const planWorkspace = (workspace: string) => {
		const freshTasks = loadTasks(query)
		const paths = worktreesOf(workspace)
		const facts: WorkspaceFacts = {
			path: workspace,
			task: freshTasks.get(basename(workspace)) ?? null,
			worktrees: paths.map((path) => worktreeFacts(path, options.useGh)),
			modifiedMs: modifiedMs(workspace, paths),
		}
		return { facts, decision: decideWorkspace(facts, options, input.nowMs ?? Date.now()) }
	}

	const workspacesRoot = join(devflowHome, 'workspaces')
	const workspaces = existsSync(workspacesRoot)
		? readdirSync(workspacesRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(workspacesRoot, entry.name))
		: []
	for (const workspace of workspaces) {
		const paths = worktreesOf(workspace)
		const facts: WorkspaceFacts = {
			path: workspace,
			task: tasks.get(basename(workspace)) ?? null,
			worktrees: paths.map((path) => worktreeFacts(path, options.useGh)),
			modifiedMs: modifiedMs(workspace, paths),
		}
		const decision = decideWorkspace(facts, options, nowMs)
		const task = facts.task !== null && facts.task !== 'ambiguous' ? facts.task : null
		if (task) decidedTasks.add(task.id)
		const label = basename(workspace)
		if (decision.action === 'remove') {
			const vm = task ? taskVmName(task.id) : null
			const vmPath = vm && vms.includes(vm) ? join(limaHome, vm) : null
			items.push({
				label: vmPath ? `${label} (+ VM ${vm})` : label,
				bytes: diskUsage(vmPath ? [workspace, vmPath] : [workspace]),
				decision,
				apply: () => {
					const changed = recheck(workspace, 'remove')
					if (changed) return changed
					const fresh = planWorkspace(workspace)
					return removeWorktrees(workspace, fresh.facts.worktrees) ?? (vm && vmPath ? deleteVm(vm) : null)
				},
			})
		} else if (decision.action === 'deps') {
			// Only installs git ignores: a tracked node_modules is the project's own content.
			const dirs = nodeModulesUnder(workspace).filter(
				(dir) =>
					run('git', ['check-ignore', '-q', dir], workspace).status === 0 ||
					run('git', ['check-ignore', '-q', dir], dir.split(`${sep}node_modules`)[0]).status === 0,
			)
			if (dirs.length === 0) continue
			items.push({
				label: `${label}/**/node_modules`,
				bytes: diskUsage(dirs),
				decision,
				apply: () => {
					const changed = recheck(workspace, 'deps')
					if (changed) return changed
					for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
					return null
				},
			})
		} else {
			items.push({ label, bytes: 0, decision, apply: () => null })
		}
	}

	// VMs of archived tasks that no workspace decision covered. A VM whose task is not in this
	// database may belong to another devflow stack, so it is left alone.
	for (const vm of vms) {
		let taskId: unknown
		try {
			taskId = (JSON.parse(readFileSync(join(limaHome, vm, 'devflow.json'), 'utf8')) as { taskId?: unknown })
				.taskId
		} catch {
			continue
		}
		if (typeof taskId !== 'string' || decidedTasks.has(taskId)) continue
		const task = [...tasks.values()].find((candidate) => candidate !== 'ambiguous' && candidate.id === taskId)
		if (!task || task === 'ambiguous' || !task.archived || task.active) continue
		items.push({
			label: `VM ${vm}`,
			bytes: diskUsage([join(limaHome, vm)]),
			decision: { action: 'remove', reason: 'task archived' },
			apply: () => {
				const fresh = [...loadTasks(query).values()].find(
					(candidate) => candidate !== 'ambiguous' && candidate.id === taskId,
				)
				if (!fresh || fresh === 'ambiguous' || fresh.active || !fresh.archived)
					return `skipped VM ${vm}: task changed`
				return deleteVm(vm)
			},
		})
	}

	const logDir = join(devflowHome, 'logs')
	if (existsSync(logDir)) {
		const old = readdirSync(logDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(jsonl|log)$/.test(entry.name))
			.map((entry) => join(logDir, entry.name))
			.filter((path) => {
				try {
					return nowMs - statSync(path).mtimeMs > options.logDays * DAY_MS
				} catch {
					return false
				}
			})
		if (old.length > 0) {
			items.push({
				label: `${old.length} log files`,
				bytes: diskUsage(old),
				decision: { action: 'remove', reason: `older than ${options.logDays} days` },
				apply: () => {
					for (const path of old) rmSync(path, { force: true })
					return null
				},
			})
		}
	}
	return items
}

export const formatBytes = (bytes: number) =>
	bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
