import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

/**
 * devflow VM sandbox: run agent processes (Claude Code, Codex) inside Lima VMs, for projects whose
 * agents need Docker or a whole OS, which the Docker sandbox cannot give them.
 *
 * Every VM is a `limactl clone` of one provisioned base (`devflow-base-<template hash>`, created on
 * first use and kept stopped), so a new VM boots instead of provisioning:
 * - `devflow-shared`: one per host, for quick tasks; its tasks share one Docker daemon.
 * - `devflow-task-<id>`: one per task, deleted when the task is archived or deleted.
 *
 * Host paths are mounted at the same paths, as in the Docker sandbox, so CLI arguments and tool
 * output need no rewriting. Lima fixes mounts while a VM runs, so each VM mounts the stable roots
 * under DEVFLOW_HOME up front; a session needing anything else (another repository's git directory)
 * restarts the VM with it added when no other session uses the VM, and fails otherwise.
 *
 * Lima's own port forwarding is off: it forwards to the same host port, which collides with the
 * host's services and other VMs. Instead each running VM's listening guest ports (>= 1024) are
 * forwarded over its ssh to a free host port, and reported with the heartbeat for the task page.
 *
 * Agent processes get their environment through a 0600 file on a mounted path that the guest reads
 * and deletes (`devflow-exec`), so tokens stay off every command line.
 */
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import {
	SANDBOX_VM_PORTS_MAX,
	SANDBOX_VMS_MAX,
	type SandboxVm,
	type SandboxVmPort,
	type VmScope,
} from '@devflow/schemas/zod/host/agent-sandbox'

import type { GithubEnv } from '@/effects/services/github-credentials/credential-files'
import logger from '@/logger'

import { outermost, sandboxLaunch } from './docker-sandbox'
import { ensureVmWorkflowPlugin } from './vm-workflow-plugin'

export interface VmToolVersions {
	readonly claudeCode: string
	readonly codex: string
	readonly gh: string
	readonly node: string
}

/** Agent CLI versions in the VM; keep in step with docker/devflow-agent/Dockerfile. */
export const VM_TOOL_VERSIONS: VmToolVersions = { claudeCode: '2.1.331', codex: '0.172.0', gh: '2.104.0', node: '22' }

export const SHARED_VM = 'devflow-shared'
const BASE_PREFIX = 'devflow-base-'
const TASK_PREFIX = 'devflow-task-'
const EXEC = '/usr/local/bin/devflow-exec'
const STATE_FILE = 'devflow.json'

export interface VmConfig {
	readonly limactl: string
	readonly devflowHome: string
	readonly limaHome: string
	readonly cpus: number
	readonly memoryGiB: number
	readonly diskGiB: number
	/** Stop a VM this long after its last session ends; 0 keeps it running. */
	readonly idleStopMs: number
	readonly portPollMs: number
}

const nonNegative = (value: string | undefined, fallback: number) => {
	const parsed = value === undefined || value === '' ? Number.NaN : Number(value)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function vmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VmConfig {
	return {
		limactl: env.DEVFLOW_LIMACTL ?? 'limactl',
		devflowHome: env.DEVFLOW_HOME ?? join(homedir(), '.devflow'),
		limaHome: env.LIMA_HOME ?? join(homedir(), '.lima'),
		cpus: nonNegative(env.DEVFLOW_VM_CPUS, 4),
		memoryGiB: nonNegative(env.DEVFLOW_VM_MEMORY_GIB, 8),
		diskGiB: nonNegative(env.DEVFLOW_VM_DISK_GIB, 60),
		idleStopMs: nonNegative(env.DEVFLOW_VM_IDLE_STOP_MINUTES, 60) * 60_000,
		portPollMs: 5_000,
	}
}

/** Directories under DEVFLOW_HOME every VM mounts: worktrees, credentials, Claude config, artifacts, clones. */
export const STABLE_ROOTS = ['workspaces', 'run', 'sandbox/claude', 'artifacts', 'repos', 'plugins'] as const

/** Mounted read-only: plugin content a later session (possibly on the host) loads. */
const READ_ONLY_ROOTS = ['plugins'] as const

/** Where the daemon stages a VM's env files: mounted in that VM only, so no other VM can read them. */
export const vmEnvDirectory = (devflowHome: string, name: string) => join(devflowHome, 'sandbox', 'vm-env', name)

/** The instance name of a task's VM: the random tail of its UUIDv7 (the head is a timestamp). */
export function taskVmName(taskId: string): string {
	return TASK_PREFIX + taskId.replace(/-/g, '').slice(-12).toLowerCase()
}

const indent = (text: string, spaces: number) =>
	text
		.split('\n')
		.map((line) => (line ? ' '.repeat(spaces) + line : line))
		.join('\n')

/** Root script that installs the agents' toolchain into the base VM once. */
export function provisionScript(versions: VmToolVersions = VM_TOOL_VERSIONS): string {
	return [
		'#!/bin/bash',
		'set -eux -o pipefail',
		'marker=/var/lib/devflow/provisioned',
		'test -f "$marker" && exit 0',
		'export DEBIAN_FRONTEND=noninteractive',
		'apt-get update',
		'apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep python3 python3-pip python3-venv build-essential unzip xz-utils openssh-client iproute2',
		'# Docker Engine; the socket belongs to the Lima user, so docker works without a new login.',
		'mkdir -p /etc/systemd/system/docker.socket.d',
		"printf '[Socket]\\nSocketUser=%s\\n' '{{.User}}' >/etc/systemd/system/docker.socket.d/override.conf",
		'curl -fsSL https://get.docker.com | sh',
		`curl -fsSL https://deb.nodesource.com/setup_${versions.node}.x | bash -`,
		'apt-get install -y nodejs',
		`npm install -g @anthropic-ai/claude-code@${versions.claudeCode} @openai/codex@${versions.codex}`,
		'npm cache clean --force',
		'arch="$(dpkg --print-architecture)"',
		`curl -fsSL "https://github.com/cli/cli/releases/download/v${versions.gh}/gh_${versions.gh}_linux_$arch.tar.gz" | tar -xz -C /tmp`,
		`install -m 0755 "/tmp/gh_${versions.gh}_linux_$arch/bin/gh" /usr/local/bin/gh && rm -rf /tmp/gh_*`,
		'curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash',
		'curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh',
		'curl -fsSL https://install.determinate.systems/nix | sh -s -- install linux --init systemd --no-confirm',
		'# Mounted repositories belong to the host uid; no SSH keys in the VM, so GitHub goes over HTTPS via gh.',
		"git config --system safe.directory '*'",
		'git config --system url."https://github.com/".insteadOf "git@github.com:"',
		'git config --system credential."https://github.com".helper \'!gh auth git-credential\'',
		`cat >${EXEC} <<'EOF'`,
		'#!/bin/bash',
		'# devflow-exec PIDFILE ENVFILE COMMAND...: load and delete the env file the daemon wrote, record',
		'# this process group so the daemon can stop it, then run COMMAND.',
		'set -euo pipefail',
		'pidfile=$1 envfile=$2',
		'shift 2',
		'set -a',
		'. "$envfile"',
		'set +a',
		'rm -f "$envfile"',
		'echo $$ >"$pidfile"',
		'exec "$@"',
		'EOF',
		`chmod 0755 ${EXEC}`,
		'mkdir -p /var/lib/devflow && touch "$marker"',
	].join('\n')
}

/** The Lima template the base VM is created from. */
export function renderVmTemplate(versions: VmToolVersions = VM_TOOL_VERSIONS): string {
	return [
		'# Generated by devflow (apps/agent-runner/src/devflow/vm-sandbox.ts). Do not edit.',
		'base: template:_images/ubuntu-lts',
		'containerd:',
		'  system: false',
		'  user: false',
		'# Each VM gets its mounts when it is cloned from the base.',
		'mounts: []',
		'# devflow forwards guest ports itself, to free host ports.',
		'portForwards:',
		'  - guestIP: 0.0.0.0',
		'    guestIPMustBeZero: false',
		'    proto: any',
		'    ignore: true',
		'provision:',
		'  - mode: system',
		'    script: |',
		indent(provisionScript(versions), 6),
		'probes:',
		'  - description: devflow toolchain installed',
		'    script: |',
		'      #!/bin/bash',
		'      set -eux -o pipefail',
		"      timeout 30s bash -c 'until test -f /var/lib/devflow/provisioned; do sleep 3; done'",
		'    hint: See /var/log/cloud-init-output.log in the VM.',
		'',
	].join('\n')
}

export const baseVmName = (template: string) =>
	BASE_PREFIX + createHash('sha256').update(template).digest('hex').slice(0, 10)

/** Quote a value for a POSIX shell `export` line. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function renderEnvFile(env: Readonly<Record<string, string>>): string {
	return Object.entries(env)
		.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
		.map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
		.join('')
}

/** Supply the host identity below guest-global and repository settings, keeping Ubuntu's system config. */
export function vmGitIdentityConfig(cwd: string): string | undefined {
	const result = spawnSync('git', ['config', '--null', '--show-scope', '--get-regexp', '^user\\.(name|email)$'], {
		cwd,
		encoding: 'utf8',
	})
	if (result.status === 1) return undefined // Neither key is configured.
	if (result.status !== 0)
		throw new Error('Could not read the host Git identity', { cause: result.error ?? result.stderr })
	const fields = result.stdout.split('\0')
	const lines: string[] = []
	for (let i = 0; i + 1 < fields.length; i += 2) {
		// Repository/worktree config is already mounted and must stay local to that repository.
		if (fields[i] !== 'global' && fields[i] !== 'system') continue
		const entry = fields[i + 1]
		if (!entry) continue
		const separator = entry.indexOf('\n')
		const key = entry.slice('user.'.length, separator)
		const value = entry
			.slice(separator + 1)
			.replaceAll('\\', '\\\\')
			.replaceAll('"', '\\"')
			.replaceAll('\n', '\\n')
			.replaceAll('\t', '\\t')
			.replaceAll('\b', '\\b')
		lines.push(`\t${key} = "${value}"`)
	}
	if (!lines.length) return undefined
	return ['[include]', '\tpath = /etc/gitconfig', '[user]', ...lines, ''].join('\n')
}

const FORWARDABLE_ADDRESSES = new Set(['0.0.0.0', '::', '*', '127.0.0.1', '::1'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

/** A guest TCP port to forward; `loopback` when it listens only on the guest's loopback. */
export interface ListeningPort {
	readonly port: number
	readonly loopback: boolean
}

/** Listening TCP ports from `ss -ltnH` that can be forwarded: 1024 and up, on a wildcard or loopback address. */
export function parseListeningPorts(ss: string): ListeningPort[] {
	const ports = new Map<number, boolean>()
	for (const line of ss.split('\n')) {
		const local = line.trim().split(/\s+/)[3]
		if (!local) continue
		const separator = local.lastIndexOf(':')
		const address = local
			.slice(0, separator)
			.replace(/^\[|\]$/g, '')
			.replace(/%.*$/, '')
		const port = Number(local.slice(separator + 1))
		if (Number.isInteger(port) && port >= 1024 && FORWARDABLE_ADDRESSES.has(address))
			ports.set(port, (ports.get(port) ?? true) && LOOPBACK_ADDRESSES.has(address))
	}
	return [...ports].sort(([a], [b]) => a - b).map(([port, loopback]) => ({ port, loopback }))
}

/** Paths in `required` that no mount in `mounted` covers. */
export function uncoveredPaths(required: readonly string[], mounted: readonly string[]): string[] {
	return required.filter(
		(path) => !mounted.some((mount) => path === mount || !relative(mount, path).startsWith('..')),
	)
}

const existingPaths = (paths: readonly (string | undefined)[]) =>
	outermost(paths.filter((path): path is string => !!path && existsSync(path)))

export interface LimaResult {
	readonly code: number | null
	readonly stdout: string
	readonly stderr: string
}

export type LimaRunner = (args: readonly string[], timeoutMs?: number, stdin?: number) => Promise<LimaResult>

/** limactl and ssh only need to find qemu and the instance directory; nothing else of the daemon's env. */
export function limaEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const keep = new Set(['PATH', 'HOME', 'USER', 'LIMA_HOME', 'TMPDIR', 'XDG_RUNTIME_DIR'])
	return Object.fromEntries(Object.entries(env).filter(([key]) => keep.has(key)))
}

/** `showProgress` passes limactl's stderr (download and provisioning progress) to the terminal; the
 * failure detail of `check` is then empty, since the person already saw it. */
export function defaultRunner(limactl: string, options: { showProgress?: boolean } = {}): LimaRunner {
	return (args, timeoutMs = 120_000, stdin) =>
		new Promise((resolve) => {
			const child = spawn(limactl, ['--tty=false', ...args], {
				env: limaEnvironment(),
				stdio: [stdin ?? 'ignore', 'pipe', options.showProgress ? 'inherit' : 'pipe'],
			})
			let stdout = ''
			let stderr = ''
			child.stdout?.on('data', (chunk: Buffer) => {
				stdout += chunk.toString()
			})
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString()
			})
			const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
			// A missing limactl emits error (ENOENT) and may never emit close.
			child.once('error', (error) => {
				clearTimeout(timer)
				resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
			})
			child.once('close', (code) => {
				clearTimeout(timer)
				resolve({ code, stdout, stderr })
			})
		})
}

interface Instance {
	readonly name: string
	readonly status: string
	readonly dir: string
}

/** What devflow records next to a VM's Lima files. */
interface VmState {
	readonly kind: VmScope | 'base'
	readonly taskId: string | null
	readonly mounts: readonly string[]
	/** Mounts given read-only (a subset of `mounts`). */
	readonly readOnly?: readonly string[]
	/** Base only: provisioning finished and the base was stopped cleanly. */
	readonly ready?: boolean
}

interface Forward {
	readonly hostPort: number
	readonly process: ChildProcess
}

interface VmEntry {
	readonly name: string
	readonly kind: VmScope
	readonly taskId: string | null
	status: SandboxVm['status']
	/** Agent runs holding the VM; it may stop or be deleted only at zero. */
	leases: number
	mounts: readonly string[]
	idleTimer?: ReturnType<typeof setTimeout>
	deleteWhenIdle: boolean
	forwards: Map<number, Forward>
	poller?: ReturnType<typeof setInterval>
	/** Bumped when forwarding stops, so a poll still awaiting Lima cannot spawn forwarders afterwards. */
	forwardGeneration: number
}

export type VmResources = Pick<VmConfig, 'cpus' | 'memoryGiB'>

export interface VmProcess {
	readonly child: ChildProcess
	readonly stop: () => void
}

/** A hold on a running VM for one agent run; the VM may stop only once every lease is released. */
export interface VmLease {
	readonly name: string
	/** Paths in `paths` that this VM does not mount. */
	readonly uncovered: (paths: readonly (string | undefined)[]) => string[]
	readonly run: (input: {
		readonly label: string
		readonly cwd: string
		readonly env: Readonly<Record<string, string>>
		readonly command: readonly string[]
	}) => VmProcess
	readonly release: () => void
}

export class VmBusyError extends Error {}

/** `preferred` when it is free on the host's loopback and not `taken`, else any free port. */
export const freeHostPort = (preferred: number, taken: ReadonlySet<number>) =>
	new Promise<number>((resolve, reject) => {
		const tryListen = (port: number) => {
			const server = createServer()
			server.once('error', (error) => (port === 0 ? reject(error) : tryListen(0)))
			server.listen(port, '127.0.0.1', () => {
				const address = server.address()
				const chosen = typeof address === 'object' && address ? address.port : port
				server.close(() => (taken.has(chosen) ? tryListen(0) : resolve(chosen)))
			})
		}
		tryListen(taken.has(preferred) ? 0 : preferred)
	})

const instanceStatus = (status: string): SandboxVm['status'] =>
	status === 'Running' ? 'running' : status === 'Broken' ? 'broken' : 'stopped'

export class VmManager {
	private readonly entries = new Map<string, VmEntry>()
	/** Startup adoption (reconcile); VM acquisition waits for it. */
	private adoption: Promise<void> = Promise.resolve()
	private readonly locks = new Map<string, Promise<unknown>>()
	private readonly lima: LimaRunner

	constructor(
		private readonly config: VmConfig = vmConfigFromEnv(),
		lima?: LimaRunner,
		private readonly spawnProcess: typeof spawn = spawn,
	) {
		this.lima = lima ?? defaultRunner(config.limactl)
	}

	/** VMs this daemon knows of, for the heartbeat. */
	snapshot(): SandboxVm[] {
		// Bounded like the heartbeat contract: an oversized report would be dropped whole.
		return [...this.entries.values()].slice(0, SANDBOX_VMS_MAX).map((entry) => ({
			name: entry.name,
			kind: entry.kind,
			taskId: entry.taskId,
			status: entry.status,
			ports: [...entry.forwards.entries()]
				.slice(0, SANDBOX_VM_PORTS_MAX)
				.map(([guestPort, forward]): SandboxVmPort => ({ guestPort, hostPort: forward.hostPort })),
		}))
	}

	/**
	 * Start (creating it if needed) the VM for a session and hold it until `release`. `paths` are
	 * the host paths the session needs inside it.
	 */
	async acquire(input: {
		readonly scope: VmScope
		readonly resources?: Partial<VmResources>
		readonly taskId: string | null
		readonly paths: readonly (string | undefined)[]
		/** The agent loads this host plugin read-only at the same path in the guest. */
		readonly workflowPluginPath?: string
	}): Promise<VmLease> {
		// Adoption sweeps agent processes left by an earlier daemon; it must not reach this session's.
		await this.adoption.catch(() => undefined)
		const name = input.scope === 'task' && input.taskId ? taskVmName(input.taskId) : SHARED_VM
		const kind: VmScope = name === SHARED_VM ? 'shared' : 'task'
		// Mounted when the VM is created, so they must exist first (a fresh DEVFLOW_HOME has neither).
		const envDirectory = vmEnvDirectory(this.config.devflowHome, name)
		for (const directory of [
			join(this.config.devflowHome, 'run'),
			join(this.config.devflowHome, 'sandbox', 'claude'),
			envDirectory,
		]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 })
		}
		const required = existingPaths([...input.paths, envDirectory, input.workflowPluginPath])
		const readOnly = [
			...READ_ONLY_ROOTS.map((root) => join(this.config.devflowHome, root)),
			...(input.workflowPluginPath ? [input.workflowPluginPath] : []),
		]
		const entry = this.entry(name, kind, kind === 'task' ? input.taskId : null)
		// Counted before the VM is ready, so an idle stop or a delete cannot race the start.
		entry.leases += 1
		entry.deleteWhenIdle = false
		clearTimeout(entry.idleTimer)
		try {
			const resources = kind === 'task' ? input.resources : undefined
			await this.locked(name, async () => {
				await this.ensureRunning(entry, required, readOnly, resources)
				if (
					input.workflowPluginPath &&
					!(await ensureVmWorkflowPlugin(this.lima, name, input.workflowPluginPath, entry.leases > 1))
				) {
					throw new VmBusyError(
						`VM ${name} needs to replace its workflow plugin and other sessions are using it; retry once they finish`,
					)
				}
			})
		} catch (error) {
			// Report what Lima has, not a start that already failed.
			const instance = await this.instance(name).catch(() => undefined)
			entry.status = instance ? instanceStatus(instance.status) : 'stopped'
			this.releaseLease(entry)
			throw error
		}
		let released = false
		return {
			name,
			uncovered: (paths) => uncoveredPaths(existingPaths(paths), entry.mounts),
			run: (run) => {
				// The SDK can spawn after its run already ended (a swept session); nothing would stop that process.
				if (released) throw new Error(`The ${name} lease was released; not starting ${run.label}`)
				return this.run(name, run)
			},
			release: () => {
				if (released) return
				released = true
				this.releaseLease(entry)
			},
		}
	}

	/** Delete a task's VM now, or once its running sessions end. */
	async deleteTaskVm(taskId: string): Promise<void> {
		const name = taskVmName(taskId)
		const entry = this.entries.get(name)
		if (entry && entry.leases > 0) {
			entry.deleteWhenIdle = true
			return
		}
		await this.locked(name, () => this.deleteVm(name))
	}

	/**
	 * At daemon start: adopt existing VMs (stopped ones stay stopped), stop agent processes a crashed
	 * daemon left in running ones, and delete task VMs whose task `isGone`.
	 */
	reconcile(isGone: (taskId: string) => boolean): Promise<void> {
		this.adoption = this.adopt(isGone)
		return this.adoption
	}

	private async adopt(isGone: (taskId: string) => boolean): Promise<void> {
		for (const instance of await this.instances()) {
			const state = this.readState(instance.dir)
			if (!state || state.kind === 'base') continue
			if (state.kind === 'task' && state.taskId && isGone(state.taskId)) {
				await this.deleteTaskVm(state.taskId)
				continue
			}
			const entry = this.entry(instance.name, state.kind, state.taskId)
			entry.mounts = state.mounts
			entry.status = instanceStatus(instance.status)
			if (entry.status !== 'running') continue
			await this.lima([
				'shell',
				instance.name,
				'--',
				'sh',
				'-c',
				'for f in /tmp/devflow-*.pid; do [ -f "$f" ] && /bin/kill -s TERM -- -"$(cat "$f")" 2>/dev/null; rm -f "$f"; done; true',
			])
			this.startForwarding(entry)
			this.armIdleStop(entry)
		}
	}

	/** Task ids of the task VMs this daemon knows of. */
	taskIds(): string[] {
		return [...this.entries.values()].flatMap((entry) =>
			entry.kind === 'task' && entry.taskId ? [entry.taskId] : [],
		)
	}

	/** Stop forwarding; the VMs keep running for the next daemon to adopt. */
	shutdown(): void {
		for (const entry of this.entries.values()) {
			clearTimeout(entry.idleTimer)
			this.stopForwarding(entry)
		}
	}

	private entry(name: string, kind: VmScope, taskId: string | null): VmEntry {
		let entry = this.entries.get(name)
		if (!entry) {
			entry = {
				name,
				kind,
				taskId,
				status: 'stopped',
				leases: 0,
				mounts: [],
				deleteWhenIdle: false,
				forwards: new Map(),
				forwardGeneration: 0,
			}
			this.entries.set(name, entry)
		}
		return entry
	}

	/** Run `work` after every earlier call for `name` has settled. */
	private locked<T>(name: string, work: () => Promise<T>): Promise<T> {
		const next = (this.locks.get(name) ?? Promise.resolve()).then(work, work)
		const settled = next.then(
			() => undefined,
			() => undefined,
		)
		this.locks.set(name, settled)
		// Drop the chain once idle, so deleted VMs leave nothing behind.
		void settled.then(() => {
			if (this.locks.get(name) === settled) this.locks.delete(name)
		})
		return next
	}

	private releaseLease(entry: VmEntry): void {
		entry.leases = Math.max(0, entry.leases - 1)
		if (entry.leases > 0) return
		if (entry.deleteWhenIdle) {
			void this.locked(entry.name, () => this.deleteVm(entry.name)).catch((error: unknown) =>
				logger.error({ vm: entry.name, taskId: entry.taskId, error }, 'Could not delete the task VM'),
			)
			return
		}
		this.armIdleStop(entry)
	}

	private armIdleStop(entry: VmEntry): void {
		clearTimeout(entry.idleTimer)
		if (this.config.idleStopMs <= 0 || entry.leases > 0) return
		entry.idleTimer = setTimeout(() => {
			void this.locked(entry.name, async () => {
				if (entry.leases > 0 || entry.status !== 'running') return
				logger.info({ vm: entry.name }, 'Stopping idle devflow VM')
				await this.stopVm(entry)
			}).catch((error: unknown) => logger.error({ vm: entry.name, error }, 'Could not stop the idle VM'))
		}, this.config.idleStopMs)
		entry.idleTimer.unref?.()
	}

	/** A task's own VM mounts its worktrees, not every task's; the shared VM serves them all. */
	private stableRoots(kind: VmScope): string[] {
		return STABLE_ROOTS.filter((root) => kind === 'shared' || root !== 'workspaces')
			.map((root) => join(this.config.devflowHome, root))
			.filter((path) => existsSync(path))
	}

	/** Make `entry`'s VM exist, mount `required` and run. */
	private async ensureRunning(
		entry: VmEntry,
		required: readonly string[],
		readOnly: readonly string[],
		resources?: Partial<VmResources>,
	): Promise<void> {
		let instance = await this.instance(entry.name)
		if (!instance) {
			const mounts = outermost([...this.stableRoots(entry.kind), ...required])
			entry.status = 'starting'
			const base = await this.ensureBase()
			await this.check(
				[
					'clone',
					base,
					entry.name,
					`--cpus=${resources?.cpus ?? this.config.cpus}`,
					`--memory=${resources?.memoryGiB ?? this.config.memoryGiB}`,
					'--set',
					mountExpression(mounts, readOnly),
				],
				600_000,
				`clone ${entry.name}`,
			)
			instance = await this.instance(entry.name)
			if (!instance) throw new Error(`limactl clone did not create ${entry.name}`)
			this.writeState(instance.dir, {
				kind: entry.kind,
				taskId: entry.taskId,
				mounts,
				readOnly: mounts.filter((mount) => readOnly.includes(mount)),
			})
			logger.info({ vm: entry.name, mounts }, 'Created devflow VM')
		}
		if (instance.status === 'Broken') {
			entry.status = 'broken'
			throw new Error(`VM ${entry.name} is broken; remove it with: limactl delete --force ${entry.name}`)
		}

		const state = this.readState(instance.dir) ?? { kind: entry.kind, taskId: entry.taskId, mounts: [] }
		entry.mounts = state.mounts
		const missing = uncoveredPaths(required, state.mounts)
		if (missing.length > 0) {
			// This session holds one lease; any other is a running agent that would lose its VM.
			if (instance.status === 'Running' && entry.leases > 1) {
				throw new VmBusyError(
					`VM ${entry.name} does not mount ${missing.join(', ')} and other sessions are using it; retry once they finish`,
				)
			}
			const mounts = outermost([...state.mounts, ...missing])
			if (instance.status === 'Running') await this.stopVm(entry)
			// Mounts the VM already had keep their mode; new ones are read-only when asked.
			const nextReadOnly = mounts.filter(
				(mount) =>
					(state.readOnly ?? []).includes(mount) || (missing.includes(mount) && readOnly.includes(mount)),
			)
			await this.check(
				['edit', entry.name, '--set', mountExpression(mounts, nextReadOnly)],
				120_000,
				`edit ${entry.name}`,
			)
			this.writeState(instance.dir, { ...state, mounts, readOnly: nextReadOnly })
			entry.mounts = mounts
			instance = { ...instance, status: 'Stopped' }
		}

		if (instance.status !== 'Running') {
			entry.status = 'starting'
			await this.check(['start', '--timeout=10m', entry.name], 660_000, `start ${entry.name}`)
		}
		entry.status = 'running'
		this.startForwarding(entry)
	}

	/**
	 * The provisioned base VM for the current template, created on first use: a ~1 GB image download
	 * plus provisioning, 15-30 minutes. `bun run devflow setup-vm` calls this ahead of `up`.
	 */
	ensureBase(): Promise<string> {
		const template = renderVmTemplate()
		// The disk size is fixed when the base is created, so it is part of the base's identity.
		const name = baseVmName(`${template}\n# disk ${this.config.diskGiB} GiB`)
		return this.locked(name, async () => {
			const instances = await this.instances()
			const existing = instances.find((instance) => instance.name === name)
			if (existing && this.readState(existing.dir)?.ready) return name
			// A base without the ready mark was interrupted while provisioning.
			if (existing) await this.check(['delete', '--force', name], 120_000, `delete ${name}`)
			const directory = join(this.config.devflowHome, 'vm')
			mkdirSync(directory, { recursive: true })
			const templatePath = join(directory, `${name}.yaml`)
			writeFileSync(templatePath, template)
			logger.info({ vm: name }, 'Provisioning the devflow base VM (several minutes, once per template)')
			await this.check(
				[
					'create',
					`--name=${name}`,
					`--cpus=${this.config.cpus}`,
					`--memory=${this.config.memoryGiB}`,
					`--disk=${this.config.diskGiB}`,
					templatePath,
				],
				1_800_000,
				`create ${name}`,
			)
			await this.check(['start', '--timeout=30m', name], 1_900_000, `provision ${name}`)
			await this.check(['stop', name], 300_000, `stop ${name}`)
			const created = await this.instance(name)
			if (!created) throw new Error(`limactl did not create ${name}`)
			this.writeState(created.dir, { kind: 'base', taskId: null, mounts: [], ready: true })
			// Clones copy the whole disk, so bases of older templates are no longer needed.
			for (const old of instances) {
				if (old.name.startsWith(BASE_PREFIX) && old.name !== name)
					await this.lima(['delete', '--force', old.name])
			}
			return name
		})
	}

	private async stopVm(entry: VmEntry): Promise<void> {
		this.stopForwarding(entry)
		await this.check(['stop', entry.name], 300_000, `stop ${entry.name}`)
		entry.status = 'stopped'
	}

	private async deleteVm(name: string): Promise<void> {
		const entry = this.entries.get(name)
		// A session that started after the delete was asked for keeps the VM.
		if (entry && entry.leases > 0) return
		if (entry) {
			clearTimeout(entry.idleTimer)
			this.stopForwarding(entry)
		}
		if (await this.instance(name)) {
			await this.check(['delete', '--force', name], 300_000, `delete ${name}`)
			logger.info({ vm: name }, 'Deleted task VM')
		}
		// A session that leased the entry meanwhile recreates the VM under the same, still listed, entry.
		if (entry && entry.leases === 0) this.entries.delete(name)
	}

	private run(name: string, input: Parameters<VmLease['run']>[0]): VmProcess {
		const id = randomUUID()
		const envDirectory = vmEnvDirectory(this.config.devflowHome, name)
		mkdirSync(envDirectory, { recursive: true, mode: 0o700 })
		const envFile = join(envDirectory, `${id}.env`)
		// A bound GitHub account already supplies its own identity. Each other process gets
		// its own defaults so concurrent tasks on a shared VM cannot overwrite one another.
		const identity = input.env.GIT_CONFIG_GLOBAL === undefined ? vmGitIdentityConfig(input.cwd) : undefined
		const gitConfig = join(envDirectory, `${id}.gitconfig`)
		if (identity !== undefined) writeFileSync(gitConfig, identity, { mode: 0o600 })
		const env = identity === undefined ? input.env : { ...input.env, GIT_CONFIG_SYSTEM: gitConfig }
		writeFileSync(envFile, renderEnvFile(env), { mode: 0o600 })
		const pidFile = `/tmp/devflow-${id}.pid`
		logger.info({ vm: name, cwd: input.cwd }, `Starting ${input.label} in the devflow VM sandbox`)
		// setsid makes the agent its own process group, which stop() ends as a whole.
		const child = this.spawnProcess(
			this.config.limactl,
			[
				'--tty=false',
				'shell',
				`--workdir=${input.cwd}`,
				name,
				'--',
				'setsid',
				'-w',
				EXEC,
				pidFile,
				envFile,
				...input.command,
			],
			{ env: limaEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
		)
		let exited = false
		let stopped = false
		// The guest deletes the env file once read; this covers a process that never got that far
		// (`error` alone fires when limactl cannot be spawned).
		const cleanUp = () => {
			if (exited) return
			exited = true
			rmSync(envFile, { force: true })
			if (identity !== undefined) rmSync(gitConfig, { force: true })
			// A stale pid file would point the next daemon's adoption sweep at a reused pid. After a
			// stop, the stop command reads and removes it: the spawners kill limactl right after stop().
			if (!stopped) void this.lima(['shell', name, '--', 'rm', '-f', pidFile])
		}
		child.once('error', cleanUp)
		child.once('exit', cleanUp)
		const stop = () => {
			if (stopped) return
			stopped = true
			// The pid file appears once devflow-exec runs; a stop right after spawn waits up to 5 s for it.
			void this.lima([
				'shell',
				name,
				'--',
				'sh',
				'-c',
				`for i in $(seq 25); do [ -f ${pidFile} ] && break; sleep 0.2; done; [ -f ${pidFile} ] && /bin/kill -s TERM -- -"$(cat ${pidFile})"; rm -f ${pidFile}`,
			]).then((result) => {
				if (result.code !== 0)
					logger.warn({ vm: name, stderr: result.stderr }, `Could not stop ${input.label} in its VM`)
			})
		}
		return { child, stop }
	}

	private startForwarding(entry: VmEntry): void {
		if (entry.poller) return
		const sshConfig = join(this.config.limaHome, entry.name, 'ssh.config')
		const poll = async () => {
			const generation = entry.forwardGeneration
			const current = () => entry.forwardGeneration === generation && entry.status === 'running'
			const listed = await this.lima(['shell', entry.name, '--', 'ss', '-ltnH'], 20_000)
			if (!current()) return
			if (listed.code !== 0) {
				// Stopped or removed behind the daemon's back (`devflow vm stop`, `limactl delete`).
				const instance = await this.instance(entry.name).catch(() => undefined)
				if (instance?.status !== 'Running') {
					entry.status = instance ? instanceStatus(instance.status) : 'stopped'
					this.stopForwarding(entry)
				}
				return
			}
			const listening = new Map(parseListeningPorts(listed.stdout).map(({ port, loopback }) => [port, loopback]))
			for (const [guestPort, forward] of entry.forwards) {
				if (!listening.has(guestPort) || forward.process.exitCode !== null) {
					forward.process.kill('SIGTERM')
					entry.forwards.delete(guestPort)
				}
			}
			const taken = new Set(
				[...this.entries.values()].flatMap((other) =>
					[...other.forwards.values()].map((forward) => forward.hostPort),
				),
			)
			for (const [guestPort, loopback] of listening) {
				if (entry.forwards.has(guestPort)) continue
				// One ssh process per port: keep the live set to what the task page can show.
				if (entry.forwards.size >= SANDBOX_VM_PORTS_MAX) break
				// A service the guest keeps on its loopback (a build cache, a language server) gets any
				// free host port: on its own number it would take the port from the host's copy of the
				// same tool whenever that one is not running (sccache's 4226).
				const hostPort = await freeHostPort(loopback ? 0 : guestPort, taken)
				if (!current()) return
				taken.add(hostPort)
				const forwarder = this.spawnProcess(
					'ssh',
					[
						'-F',
						sshConfig,
						'-N',
						'-o',
						'ExitOnForwardFailure=yes',
						'-o',
						'ControlMaster=no',
						'-o',
						'ControlPath=none',
						'-L',
						`127.0.0.1:${hostPort}:localhost:${guestPort}`,
						`lima-${entry.name}`,
					],
					{ env: limaEnvironment(), stdio: 'ignore' },
				)
				const drop = () => {
					if (entry.forwards.get(guestPort)?.process === forwarder) entry.forwards.delete(guestPort)
				}
				forwarder.once('exit', drop)
				// A missing ssh emits error (ENOENT) and may never emit exit.
				forwarder.once('error', (error) => {
					logger.warn({ vm: entry.name, guestPort, error }, 'Could not forward VM port')
					drop()
				})
				entry.forwards.set(guestPort, { hostPort, process: forwarder })
				logger.info({ vm: entry.name, guestPort, hostPort }, 'Forwarding VM port')
			}
		}
		let polling = false
		entry.poller = setInterval(() => {
			if (polling || entry.status !== 'running') return
			polling = true
			void poll()
				.catch((error: unknown) => logger.debug({ vm: entry.name, error }, 'VM port poll failed'))
				.finally(() => {
					polling = false
				})
		}, this.config.portPollMs)
		entry.poller.unref?.()
	}

	private stopForwarding(entry: VmEntry): void {
		entry.forwardGeneration += 1
		clearInterval(entry.poller)
		entry.poller = undefined
		for (const forward of entry.forwards.values()) forward.process.kill('SIGTERM')
		entry.forwards.clear()
	}

	private async instance(name: string): Promise<Instance | undefined> {
		return (await this.instances()).find((candidate) => candidate.name === name)
	}

	private async instances(): Promise<Instance[]> {
		const listed = await this.lima(['list', '--json'], 30_000)
		if (listed.code !== 0) throw new Error(`limactl list failed: ${listed.stderr.trim() || listed.code}`)
		return parseInstances(listed.stdout)
	}

	private async check(args: readonly string[], timeoutMs: number, what: string): Promise<LimaResult> {
		const result = await this.lima(args, timeoutMs)
		if (result.code !== 0) {
			const detail = result.stderr.trim().split('\n').slice(-5).join('\n')
			throw new Error(`limactl ${what} failed (${result.code ?? 'timed out'}): ${detail}`)
		}
		return result
	}

	/** devflow's record of a VM, or null when it is missing or not one devflow wrote (never reported). */
	private readState(dir: string): VmState | null {
		try {
			return parseVmState(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')))
		} catch {
			return null
		}
	}

	private writeState(dir: string, state: VmState): void {
		writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2))
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const stringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string')

/** A VM state file as devflow wrote it; anything else is ignored rather than adopted and reported. */
export function parseVmState(value: unknown): VmState | null {
	if (typeof value !== 'object' || value === null) return null
	const state = value as { kind?: unknown; taskId?: unknown; mounts?: unknown; readOnly?: unknown; ready?: unknown }
	const kind = state.kind
	if (kind !== 'shared' && kind !== 'task' && kind !== 'base') return null
	const taskId = state.taskId ?? null
	if (taskId !== null && !(typeof taskId === 'string' && UUID.test(taskId))) return null
	if (!stringList(state.mounts)) return null
	if (state.readOnly !== undefined && !stringList(state.readOnly)) return null
	return { kind, taskId, mounts: state.mounts, readOnly: state.readOnly, ready: state.ready === true }
}

/** `limactl list --json` prints one JSON object per line (an array on some versions). */
export function parseInstances(stdout: string): Instance[] {
	const text = stdout.trim()
	if (!text) return []
	const rows: unknown[] = text.startsWith('[')
		? (JSON.parse(text) as unknown[])
		: text
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown)
	return rows.flatMap((row) => {
		const value = row as { name?: unknown; status?: unknown; dir?: unknown }
		return typeof value.name === 'string' && typeof value.dir === 'string'
			? [{ name: value.name, status: typeof value.status === 'string' ? value.status : '', dir: value.dir }]
			: []
	})
}

/** A `--set` yq expression giving the VM exactly `mounts`, writable, at their host paths. */
export function mountExpression(mounts: readonly string[], readOnly: readonly string[] = []): string {
	const entries = mounts.map((location) => ({ location, writable: !readOnly.includes(location) }))
	return `.mounts = ${JSON.stringify(entries)}`
}

/** The daemon's VM manager. */
export const vmManager = new VmManager()

/** The daemon collection the task VM watcher reads. */
export interface TaskVmSources {
	readonly tasks: {
		get(id: string): { readonly archived: boolean } | undefined
		subscribeChanges(
			callback: (
				changes: ReadonlyArray<{ readonly value: { readonly id: string; readonly archived: boolean } }>,
			) => void,
			options: { includeInitialState: boolean },
		): { unsubscribe(): void }
	}
}

/**
 * Delete task VMs once their task is archived, as the change syncs and on a periodic check, and
 * adopt existing VMs at daemon start. A task missing from the daemon's collection is not taken as
 * deleted: tasks sync on demand, so absence also means "not loaded", and a VM holds state (Docker
 * volumes) that cannot be recovered. A task deleted without being archived keeps its VM until
 * `bun run devflow vm rm`.
 */
export function watchTaskVms(
	sources: TaskVmSources,
	manager: VmManager = vmManager,
	checkEveryMs = 60_000,
): () => void {
	const remove = (taskId: string) =>
		manager
			.deleteTaskVm(taskId)
			.catch((error: unknown) => logger.error({ taskId, error }, 'Could not delete the task VM'))
	const archived = (taskId: string) => sources.tasks.get(taskId)?.archived === true

	void manager
		.reconcile(archived)
		.catch((error: unknown) => logger.debug({ error }, 'No devflow VMs to adopt (is limactl installed?)'))
	const subscription = sources.tasks.subscribeChanges(
		(changes) => {
			const known = new Set(manager.taskIds())
			for (const { value } of changes) if (value.archived && known.has(value.id)) void remove(value.id)
		},
		{ includeInitialState: false },
	)
	const timer = setInterval(() => {
		for (const taskId of manager.taskIds()) if (archived(taskId)) void remove(taskId)
	}, checkEveryMs)
	timer.unref?.()
	return () => {
		clearInterval(timer)
		subscription.unsubscribe()
		manager.shutdown()
	}
}

/**
 * Run each Claude Code process of a session in the leased VM, over the same stdio protocol, mounts
 * and environment allowlist as the Docker sandbox.
 */
export function createVmSandboxSpawner(
	lease: VmLease,
	input: {
		readonly cwd: string
		readonly mountPaths: readonly (string | undefined)[]
		readonly githubEnv?: GithubEnv | null
	},
): (options: SpawnOptions) => SpawnedProcess {
	return (options) => {
		const { cwd, mounts, env } = sandboxLaunch(options, input)
		const uncovered = lease.uncovered(mounts)
		if (uncovered.length > 0)
			logger.warn({ vm: lease.name, uncovered }, 'Paths Claude Code was given are not mounted in its VM')
		// The guest keeps its own HOME (tool caches, nix profile); only Claude's config comes from the host.
		const { HOME: _home, ...vmEnv } = env
		const { child, stop } = lease.run({
			label: 'Claude Code',
			cwd,
			env: vmEnv,
			command: ['claude', ...options.args],
		})
		child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[vm] ${chunk.toString()}`))
		options.signal?.addEventListener('abort', stop, { once: true })
		const kill = child.kill.bind(child)
		child.kill = (signal?: NodeJS.Signals | number) => {
			stop()
			return kill(signal)
		}
		// Spawned with piped stdio, so both streams exist; the SDK's type says so.
		const { stdin, stdout } = child
		if (!stdin || !stdout) throw new Error('limactl shell started without piped stdio')
		return Object.assign(child, { stdin, stdout })
	}
}
