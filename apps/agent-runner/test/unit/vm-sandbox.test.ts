import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
	githubCredentialScope,
	hostDefaultSandbox,
	sessionSandbox,
	waitForTaskSandbox,
	whileLaunching,
} from '@/devflow/agent-sandbox'
import { taskWorkspaceMounts, vmCodexEnvironment } from '@/devflow/codex-app-server'
import { sandboxEnvironment } from '@/devflow/docker-sandbox'
import {
	baseVmName,
	type LimaResult,
	mountExpression,
	parseInstances,
	parseListeningPorts,
	parseVmState,
	renderEnvFile,
	renderVmTemplate,
	SHARED_VM,
	taskVmName,
	uncoveredPaths,
	type VmConfig,
	VmBusyError,
	VmManager,
	watchTaskVms,
} from '@/devflow/vm-sandbox'

const scratch = mkdtempSync(join(tmpdir(), 'vm-sandbox-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const TASK_ID = '019b049c-950d-7baa-b9a8-b9364599319b'

describe('waitForTaskSandbox', () => {
	it('waits for the task row, and fails rather than guess when it never arrives', async () => {
		let row: { sandbox: 'vm-task'; vm_cpus: number; vm_memory_gib: number } | undefined
		setTimeout(() => {
			row = { sandbox: 'vm-task', vm_cpus: 8, vm_memory_gib: 16 }
		}, 300)
		await expect(waitForTaskSandbox(() => row, TASK_ID, 2_000)).resolves.toEqual({
			id: TASK_ID,
			sandbox: 'vm-task',
			vmResources: { cpus: 8, memoryGiB: 16 },
		})
		await expect(waitForTaskSandbox(() => undefined, TASK_ID, 300)).rejects.toThrow(/has not synced/)
	})
})

describe('whileLaunching', () => {
	afterEach(() => vi.useRealTimers())

	it('reports activity while the VM starts, and stops once it is up', async () => {
		vi.useFakeTimers()
		const bump = vi.fn(() => Promise.resolve())
		let started: (value: string) => void = () => {}
		const done = whileLaunching(new Promise<string>((resolve) => (started = resolve)), bump, 30_000)
		await vi.advanceTimersByTimeAsync(95_000)
		expect(bump).toHaveBeenCalledTimes(3)
		started('vm')
		await expect(done).resolves.toBe('vm')
		await vi.advanceTimersByTimeAsync(60_000)
		expect(bump).toHaveBeenCalledTimes(3)
	})
})

describe('taskWorkspaceMounts', () => {
	it("mounts a multi-repository task's whole workspace and each worktree's repository for Codex", () => {
		const root = mkdtempSync(join(scratch, 'codex-ws-'))
		const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })
		const repos = join(root, 'repos')
		const workspaces = join(root, 'workspaces')
		mkdirSync(workspaces, { recursive: true })
		for (const name of ['frontend', 'backend']) {
			const repo = join(repos, name)
			mkdirSync(repo, { recursive: true })
			git(repo, 'init', '-q', '-b', 'main')
			git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
			git(repo, 'worktree', 'add', '-q', '-b', 'task', join(workspaces, 'task', name))
		}
		const mounts = taskWorkspaceMounts(join(workspaces, 'task', 'frontend'), workspaces)
		expect(mounts).toContain(join(workspaces, 'task'))
		expect(mounts).toEqual(
			expect.arrayContaining(
				[join(repos, 'frontend', '.git'), join(repos, 'backend', '.git')].map((path) =>
					expect.stringContaining(path),
				),
			),
		)
	})
})

describe('sandbox environment', () => {
	it("keeps devflow's own secrets out of Claude Code and Codex in a sandbox", () => {
		const env = {
			DEVFLOW_SESSION_ID: 'session',
			DEVFLOW_DAEMON_TOKEN_PRIVATE_KEY: 'signing-key',
			DEVFLOW_AUTH_PRIVATE_JWK_PATH: '/keys/user.jwk',
			CLAUDE_CODE_OAUTH_TOKEN: 'claude-login',
			OPENAI_API_KEY: 'openai',
		}
		const claude = sandboxEnvironment(env, { configDir: '/c', githubEnv: null })
		expect(claude).toMatchObject({ DEVFLOW_SESSION_ID: 'session', CLAUDE_CODE_OAUTH_TOKEN: 'claude-login' })
		const codex = vmCodexEnvironment(null, env)
		expect(codex).toMatchObject({ DEVFLOW_SESSION_ID: 'session', OPENAI_API_KEY: 'openai' })
		for (const leaked of [claude, codex]) {
			expect(leaked).not.toHaveProperty('DEVFLOW_DAEMON_TOKEN_PRIVATE_KEY')
			expect(leaked).not.toHaveProperty('DEVFLOW_AUTH_PRIVATE_JWK_PATH')
		}
	})
})

describe('sessionSandbox', () => {
	it('uses the task sandbox, else the host default', () => {
		expect(sessionSandbox({ id: TASK_ID, sandbox: 'vm-task' }, 'docker')).toBe('vm-task')
		expect(sessionSandbox({ id: TASK_ID, sandbox: null }, 'docker')).toBe('docker')
		expect(sessionSandbox({ id: TASK_ID, sandbox: null }, 'vm')).toBe('vm-shared')
		expect(sessionSandbox(null, undefined)).toBe('none')
		expect(hostDefaultSandbox('something-else')).toBe('none')
	})

	it('keeps host-login credentials only for agents on the host', () => {
		expect(githubCredentialScope('none')).toBe('host')
		expect(githubCredentialScope('vm-shared')).toBe('sandbox')
		expect(githubCredentialScope('docker')).toBe('sandbox')
	})
})

describe('pure helpers', () => {
	it('names a task VM after the random tail of its UUIDv7', () => {
		expect(taskVmName(TASK_ID)).toBe('devflow-task-b9364599319b')
		// Two tasks created in the same millisecond share the timestamp head, not the tail.
		expect(taskVmName('019b049c-950d-7000-8000-000000000001')).not.toBe(
			taskVmName('019b049c-950d-7000-8000-000000000002'),
		)
	})

	it('writes an env file that a shell reads back exactly', () => {
		const values = {
			PLAIN: 'value',
			QUOTES: `it's "quoted" \\ and $HOME \`ticks\``,
			LINES: 'first\nsecond',
		}
		const envFile = join(scratch, 'agent.env')
		writeFileSync(envFile, renderEnvFile({ ...values, 'BAD-KEY': 'dropped' }))
		const read = spawnSync(
			'bash',
			['-c', 'set -a; . "$1"; set +a; printf "%s\\0" "$PLAIN" "$QUOTES" "$LINES"', 'bash', envFile],
			{
				encoding: 'utf8',
				env: { PATH: process.env.PATH, HOME: '/should-not-expand' },
			},
		)
		expect(read.stderr).toBe('')
		const [PLAIN, QUOTES, LINES] = read.stdout.split('\0')
		expect({ PLAIN, QUOTES, LINES }).toEqual(values)
	})

	it('forwards listening ports from 1024 up on wildcard and loopback addresses, marking loopback-only ones', () => {
		const ss = [
			'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
			'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
			'LISTEN 0      4096         0.0.0.0:5432       0.0.0.0:*',
			'LISTEN 0      4096            [::]:5432          [::]:*',
			'LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*',
			'LISTEN 0      511            [::1]:8080          [::]:*',
			'LISTEN 0      511                *:9000             *:*',
			'LISTEN 0      511     192.168.5.15:7000       0.0.0.0:*',
			'LISTEN 0      511        127.0.0.1:9000       0.0.0.0:*',
		].join('\n')
		expect(parseListeningPorts(ss)).toEqual([
			{ port: 3000, loopback: true },
			{ port: 5432, loopback: false },
			{ port: 8080, loopback: true },
			{ port: 9000, loopback: false },
		])
	})

	it('mounts read-only only what it is asked to', () => {
		expect(mountExpression(['/a', '/p'], ['/p'])).toBe(
			'.mounts = [{"location":"/a","writable":true},{"location":"/p","writable":false}]',
		)
	})

	it('adopts only state files devflow wrote', () => {
		expect(parseVmState({ kind: 'task', taskId: TASK_ID, mounts: ['/a'] })).toMatchObject({
			kind: 'task',
			taskId: TASK_ID,
		})
		expect(parseVmState({ kind: 'task', taskId: 'not-a-uuid', mounts: [] })).toBeNull()
		expect(parseVmState({ kind: 'other', taskId: null, mounts: [] })).toBeNull()
		expect(parseVmState({ kind: 'shared', taskId: null, mounts: 'x' })).toBeNull()
		expect(parseVmState(null)).toBeNull()
	})

	it('finds paths no mount covers', () => {
		expect(uncoveredPaths(['/a/b/c', '/x/y', '/ab'], ['/a', '/x/y'])).toEqual(['/ab'])
	})

	it('sets mounts with a yq expression of writable same-path entries', () => {
		expect(mountExpression(['/home/me/.devflow/run', '/tmp/a "b"'])).toBe(
			'.mounts = [{"location":"/home/me/.devflow/run","writable":true},{"location":"/tmp/a \\"b\\"","writable":true}]',
		)
	})

	it('reads limactl list output as JSON lines or an array', () => {
		const row = { name: 'devflow-shared', status: 'Running', dir: '/l/devflow-shared' }
		expect(parseInstances(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, name: 'other' })}\n`)).toHaveLength(2)
		expect(parseInstances(JSON.stringify([row]))).toEqual([row])
		expect(parseInstances('')).toEqual([])
	})

	it('turns off Lima port forwarding and pins the agent tools in the template', () => {
		const template = renderVmTemplate({ claudeCode: '9.9.9', codex: '1.2.3', gh: '2.0.0', node: '22' })
		expect(template).toContain('guestIPMustBeZero: false')
		expect(template).toContain('ignore: true')
		expect(template).toContain('@anthropic-ai/claude-code@9.9.9 @openai/codex@1.2.3')
		expect(template).toContain('mounts: []')
		expect(baseVmName(template)).toMatch(/^devflow-base-[0-9a-f]{10}$/)
		expect(baseVmName(template)).not.toBe(baseVmName(renderVmTemplate()))
	})
})

/** An in-memory limactl: instances, their status, and every call made. */
function fakeLima(limaHome: string) {
	const instances = new Map<string, { status: string; dir: string }>()
	const calls: string[][] = []
	const run = async (args: readonly string[]): Promise<LimaResult> => {
		calls.push([...args])
		const ok = (stdout = ''): LimaResult => ({ code: 0, stdout, stderr: '' })
		const [command, ...rest] = args
		const named = (name: string) => {
			const dir = join(limaHome, name)
			mkdirSync(dir, { recursive: true })
			instances.set(name, { status: 'Stopped', dir })
		}
		switch (command) {
			case 'list':
				return ok([...instances].map(([name, value]) => JSON.stringify({ name, ...value })).join('\n'))
			case 'create':
				named(String(rest.find((arg) => arg.startsWith('--name='))).slice('--name='.length))
				return ok()
			case 'clone':
				named(rest[1] ?? '')
				return ok()
			case 'start':
			case 'stop': {
				const instance = instances.get(rest.at(-1) ?? '')
				if (instance) instance.status = command === 'start' ? 'Running' : 'Stopped'
				return ok()
			}
			case 'delete':
				instances.delete(rest.at(-1) ?? '')
				return ok()
			default:
				return ok()
		}
	}
	return { instances, calls, run }
}

function setup(overrides: Partial<VmConfig> = {}) {
	const root = mkdtempSync(join(scratch, 'manager-'))
	const devflowHome = join(root, 'devflow')
	for (const dir of ['workspaces', 'run', 'sandbox']) mkdirSync(join(devflowHome, dir), { recursive: true })
	const repo = join(root, 'repo', '.git')
	mkdirSync(repo, { recursive: true })
	const lima = fakeLima(join(root, 'lima'))
	const config: VmConfig = {
		limactl: 'limactl',
		devflowHome,
		limaHome: join(root, 'lima'),
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 20,
		idleStopMs: 0,
		portPollMs: 3_600_000,
		...overrides,
	}
	const manager = new VmManager(config, lima.run)
	const worktree = join(devflowHome, 'workspaces', 'task-a')
	mkdirSync(worktree, { recursive: true })
	return { manager, lima, devflowHome, repo, worktree, root }
}

const commands = (calls: string[][]) => calls.map((call) => call[0]).filter((command) => command !== 'list')

describe('VmManager', () => {
	afterEach(() => vi.useRealTimers())

	it('provisions the base once, clones a task VM with the stable roots and the repository mounted, and reuses it', async () => {
		const { manager, lima, devflowHome, repo, worktree } = setup()
		const first = await manager.acquire({
			scope: 'task',
			taskId: TASK_ID,
			paths: [worktree, repo, '/does/not/exist'],
		})
		expect(first.name).toBe(taskVmName(TASK_ID))
		expect(commands(lima.calls)).toEqual(['create', 'start', 'stop', 'clone', 'start'])
		const clone = lima.calls.find((call) => call[0] === 'clone') ?? []
		// Resources come from the daemon's settings at clone time, not from when the base was made.
		expect(clone).toEqual(expect.arrayContaining(['--cpus=2', '--memory=4']))
		const setAt = clone.indexOf('--set')
		expect(setAt).toBeGreaterThan(0)
		const mounts = JSON.parse(String(clone[setAt + 1]).slice('.mounts = '.length)) as Array<{
			location: string
			writable: boolean
		}>
		expect(mounts.every((mount) => mount.writable)).toBe(true)
		expect(mounts.map((mount) => mount.location).sort()).toEqual(
			[
				worktree,
				join(devflowHome, 'run'),
				join(devflowHome, 'sandbox', 'claude'),
				// Env files are staged where only this VM can read them.
				join(devflowHome, 'sandbox', 'vm-env', taskVmName(TASK_ID)),
				repo,
			].sort(),
		)
		expect(first.uncovered([worktree, '/elsewhere'])).toEqual([])
		first.release()

		lima.calls.length = 0
		const again = await manager.acquire({ scope: 'task', taskId: TASK_ID, paths: [worktree] })
		expect(commands(lima.calls)).toEqual([])
		again.release()
		expect(manager.snapshot()).toEqual([
			{ name: taskVmName(TASK_ID), kind: 'task', taskId: TASK_ID, status: 'running', ports: [] },
		])
	})

	it.each([
		{ scope: 'task', resources: { cpus: 8, memoryGiB: 16 }, cpus: 8, memoryGiB: 16 },
		{ scope: 'task', resources: { cpus: 6 }, cpus: 6, memoryGiB: 4 },
		{ scope: 'task', resources: { memoryGiB: 12 }, cpus: 2, memoryGiB: 12 },
		{ scope: 'shared', resources: { cpus: 8, memoryGiB: 16 }, cpus: 2, memoryGiB: 4 },
	] as const)(
		'clones a $scope VM with $cpus CPUs and $memoryGiB GiB',
		async ({ scope, resources, cpus, memoryGiB }) => {
			const { manager, lima } = setup()
			const lease = await manager.acquire({ scope, taskId: TASK_ID, resources, paths: [] })
			expect(lima.calls.find(([command]) => command === 'create')).toEqual(
				expect.arrayContaining(['--cpus=2', '--memory=4']),
			)
			expect(lima.calls.find(([command]) => command === 'clone')).toEqual(
				expect.arrayContaining([`--cpus=${cpus}`, `--memory=${memoryGiB}`]),
			)
			lease.release()
		},
	)

	it('adds a mount by restarting an idle VM, and refuses while another session uses it', async () => {
		const { manager, lima, worktree, root } = setup()
		const held = await manager.acquire({ scope: 'shared', taskId: null, paths: [worktree] })
		expect(held.name).toBe(SHARED_VM)
		const other = join(root, 'other-repo')
		mkdirSync(other)
		await expect(manager.acquire({ scope: 'shared', taskId: null, paths: [other] })).rejects.toBeInstanceOf(
			VmBusyError,
		)

		held.release()
		lima.calls.length = 0
		const next = await manager.acquire({ scope: 'shared', taskId: null, paths: [other] })
		expect(commands(lima.calls)).toEqual(['stop', 'edit', 'start'])
		expect(next.uncovered([other])).toEqual([])
		next.release()
	})

	it('gives the first VM commit the host identity while honoring repository and session identities', async () => {
		const { manager, lima, root, worktree } = setup()
		const guestHome = join(root, 'guest')
		mkdirSync(guestHome)
		const hostConfig = join(root, 'host.gitconfig')
		const included = join(root, 'included.gitconfig')
		const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree })
		git('init', '-q')
		const hostName = 'Dev "Q" \\ Example'
		git('config', '--file', included, 'user.name', hostName)
		git('config', '--file', included, 'user.email', 'dev@example.org')
		git('config', '--file', included, 'credential.helper', 'host-only')
		git('config', '--file', hostConfig, 'include.path', included)
		const accountConfig = join(root, 'account.gitconfig')
		git('config', '--file', accountConfig, 'user.name', 'Selected account')
		git('config', '--file', accountConfig, 'user.email', 'account@example.org')
		const spawned = { once: vi.fn() }
		const launch = vi.fn(() => spawned)
		const vm = new VmManager(manager['config'], lima.run, launch as never)
		const lease = await vm.acquire({ scope: 'shared', taskId: null, paths: [worktree] })
		const firstCommit = (env: Record<string, string>) => {
			lease.run({ label: 'Codex', cwd: worktree, env, command: ['codex'] })
			const args = (launch.mock.lastCall as unknown as [string, string[]])[1]
			const envFile = args[args.indexOf('/usr/local/bin/devflow-exec') + 2]!
			const guest = (cmd: string) =>
				execFileSync('sh', ['-ec', '. "$1"; ' + cmd, 'sh', envFile], {
					cwd: worktree,
					env: { HOME: guestHome, PATH: process.env.PATH },
					encoding: 'utf8',
				}).trimEnd()
			expect(guest('git config --get-all credential.helper || true')).not.toContain('host-only')
			guest('git commit -q --allow-empty -m test')
			return guest("git log -1 --format='%an <%ae>|%cn <%ce>'")
		}
		vi.stubEnv('GIT_CONFIG_GLOBAL', hostConfig)
		try {
			const host = hostName + ' <dev@example.org>'
			expect(firstCommit({})).toBe(host + '|' + host)
			const account = 'Selected account <account@example.org>'
			expect(firstCommit({ GIT_CONFIG_GLOBAL: accountConfig })).toBe(account + '|' + account)
			git('config', '--local', 'user.name', 'Repository')
			const local = 'Repository <dev@example.org>'
			expect(firstCommit({})).toBe(local + '|' + local)
		} finally {
			lease.release()
			vi.unstubAllEnvs()
		}
	})

	it('stops agents with procps kill: dash, the guest sh, rejects `kill -TERM -- -pgid`', async () => {
		const { manager, lima, worktree } = setup()
		const spawned = { kill: vi.fn(), once: vi.fn(), stdin: {}, stdout: {} }
		const withSpawn = new VmManager(
			{ ...manager['config'], idleStopMs: 0 },
			lima.run,
			vi.fn(() => spawned) as never,
		)
		const lease = await withSpawn.acquire({ scope: 'shared', taskId: null, paths: [worktree] })
		lease.run({ label: 'Claude Code', cwd: worktree, env: {}, command: ['claude'] }).stop()
		const stopCall = lima.calls.find((call) => call.join(' ').includes('kill'))
		expect(stopCall?.join(' ')).toContain('/bin/kill -s TERM -- -')
		lease.release()
	})

	it('refuses to start a process on a released lease', async () => {
		const { manager, worktree } = setup()
		const lease = await manager.acquire({ scope: 'shared', taskId: null, paths: [worktree] })
		lease.release()
		expect(() => lease.run({ label: 'Claude Code', cwd: worktree, env: {}, command: ['claude'] })).toThrow(
			/released/,
		)
	})

	it('deletes a task VM once its last session releases it', async () => {
		const { manager, lima, worktree } = setup()
		const lease = await manager.acquire({ scope: 'task', taskId: TASK_ID, paths: [worktree] })
		await manager.deleteTaskVm(TASK_ID)
		expect(lima.instances.has(taskVmName(TASK_ID))).toBe(true)
		lease.release()
		await vi.waitFor(() => expect(lima.instances.has(taskVmName(TASK_ID))).toBe(false))
		expect(manager.snapshot()).toEqual([])
	})

	it('stops a VM after the idle timeout', async () => {
		vi.useFakeTimers()
		const { manager, lima, worktree } = setup({ idleStopMs: 60_000 })
		const lease = await manager.acquire({ scope: 'shared', taskId: null, paths: [worktree] })
		lease.release()
		await vi.advanceTimersByTimeAsync(59_000)
		expect(lima.instances.get(SHARED_VM)?.status).toBe('Running')
		await vi.advanceTimersByTimeAsync(2_000)
		expect(lima.instances.get(SHARED_VM)?.status).toBe('Stopped')
	})

	it('deletes the VM of an archived task, and keeps one whose task is only missing from the collection', async () => {
		vi.useFakeTimers()
		const { manager, lima, worktree } = setup()
		const archivedTask = '019b049c-950d-7baa-b9a8-000000000aaa'
		const unloadedTask = '019b049c-950d-7baa-b9a8-000000000bbb'
		for (const taskId of [archivedTask, unloadedTask]) {
			;(await manager.acquire({ scope: 'task', taskId, paths: [worktree] })).release()
		}
		const rows = new Map([[archivedTask, { archived: false }]])
		let notify: (changes: Array<{ value: { id: string; archived: boolean } }>) => void = () => {}
		const stop = watchTaskVms(
			{
				tasks: {
					get: (id) => rows.get(id),
					subscribeChanges: (callback) => {
						notify = callback
						return { unsubscribe: () => {} }
					},
				},
			},
			manager,
			1_000,
		)
		notify([{ value: { id: archivedTask, archived: true } }])
		await vi.waitFor(() => expect(lima.instances.has(taskVmName(archivedTask))).toBe(false))
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		expect(lima.instances.has(taskVmName(unloadedTask))).toBe(true)
		stop()
	})

	it("mounts only a task's own worktree in its VM, every task's in the shared one", async () => {
		const { manager, lima, devflowHome, worktree } = setup()
		;(await manager.acquire({ scope: 'task', taskId: TASK_ID, paths: [worktree] })).release()
		;(await manager.acquire({ scope: 'shared', taskId: null, paths: [worktree] })).release()
		const [task, shared] = lima.calls.filter((call) => call[0] === 'clone').map((call) => String(call.at(-1)))
		expect(task).toContain(worktree)
		expect(task).not.toContain(`"${join(devflowHome, 'workspaces')}"`)
		expect(shared).toContain(`"${join(devflowHome, 'workspaces')}"`)
	})
})
