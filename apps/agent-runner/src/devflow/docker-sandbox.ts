/**
 * devflow agent sandbox: run each Claude Code process in a Docker container instead of on the host.
 *
 * Plugged into the Agent SDK through `spawnClaudeCodeProcess`, so the SDK's stream-json protocol,
 * hooks, permission callbacks and in-process MCP servers keep working over the container's stdio.
 * Every host path the CLI needs (worktree, task artifacts, plugin directories, the repository's
 * git directory, files named in the CLI arguments) is bind-mounted at the same path, so arguments
 * and tool output need no path rewriting. On macOS, Colima shares only $HOME with its VM, which
 * covers every devflow path.
 *
 * Isolation: the container sees only those mounts and its own Claude config directory
 * (DEVFLOW_HOME/sandbox/claude, not ~/.claude), and receives only allowlisted environment
 * variables, so daemon secrets (database URL, token signing key) never enter it.
 *
 * Used for tasks whose sandbox is `docker` (see agent-sandbox.ts); `vm` tasks use vm-sandbox.ts.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

import { withGithubEnvironment, type GithubEnv } from '@/effects/services/github-credentials/credential-files'
import logger from '@/logger'

export function isDockerSandboxEnabled(): boolean {
	return process.env.DEVFLOW_AGENT_SANDBOX === 'docker'
}

const IMAGE = process.env.DEVFLOW_AGENT_IMAGE ?? 'devflow-agent:latest'
const CONTAINER_LABEL = 'devflow.agent=1'

export function sandboxClaudeConfigDir(): string {
	return join(process.env.DEVFLOW_HOME ?? join(homedir(), '.devflow'), 'sandbox', 'claude')
}

// Environment passed into the container: Claude Code / SDK settings, Anthropic auth, git identity
// devflow session metadata, GH_TOKEN for the PR stage, and the two pointers at a session's GitHub
// credential directory. Everything else stays out.
const ENV_ALLOW =
	/^(CLAUDE_|ANTHROPIC_|ENABLE_TOOL_SEARCH$|MCP_|GIT_(AUTHOR|COMMITTER)_|DEVFLOW_|DISABLE_|MAX_THINKING_TOKENS$|BASH_|GH_TOKEN$|GH_CONFIG_DIR$|GIT_CONFIG_GLOBAL$)/

/**
 * devflow's own secrets that share the DEVFLOW_ prefix: the daemon's token signing key, and URLs that
 * can carry credentials (test database URLs embed a password).
 * They never enter a sandbox, whatever else of DEVFLOW_ does.
 */
export const DEVFLOW_SECRET_ENV = /^DEVFLOW_.*(KEY|TOKEN|SECRET|PASSWORD|JWK|CREDS|URL|DSN)/

/** The two variables only a session's own credential directory may set inside the container. */
const GITHUB_CREDENTIAL_POINTERS = ['GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL'] as const

/** Drop paths nested inside another mount; Docker would mount both, the outer one is enough. */
export function outermost(paths: Iterable<string>): string[] {
	const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length)
	const kept: string[] = []
	for (const path of sorted) {
		if (!kept.some((parent) => path === parent || !relative(parent, path).startsWith('..'))) kept.push(path)
	}
	return kept
}

function gitCommonDir(cwd: string): string | undefined {
	const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
		cwd,
		encoding: 'utf8',
	})
	const dir = result.status === 0 ? result.stdout.trim() : ''
	return dir.length > 0 ? dir : undefined
}

/**
 * Start `command` in a sandbox container with `mounts` at their host paths and only `env` passed
 * in. Returns the docker CLI child (stdio piped) and a function that stops the container.
 */
export function runInSandbox(input: {
	readonly label: string
	readonly cwd: string
	readonly mounts: readonly (string | undefined)[]
	readonly env: Record<string, string>
	readonly command: readonly string[]
}): { readonly child: ChildProcess; readonly stop: () => void } {
	const mounts = outermost(input.mounts.filter((path): path is string => !!path && existsSync(path)))
	const name = `devflow-agent-${randomUUID().slice(0, 12)}`
	const uid = process.getuid?.() ?? 1000
	const gid = process.getgid?.() ?? 1000
	const dockerArgs = [
		'run',
		'--rm',
		'-i',
		'--name',
		name,
		'--label',
		CONTAINER_LABEL,
		'--user',
		`${uid}:${gid}`,
		'--workdir',
		input.cwd,
		...mounts.flatMap((path) => ['--volume', `${path}:${path}`]),
		// `-e KEY` copies the value from the docker CLI's environment, keeping secrets off argv.
		...Object.keys(input.env).flatMap((key) => ['--env', key]),
		IMAGE,
		...input.command,
	]
	logger.info({ container: name, mounts, cwd: input.cwd }, `Starting ${input.label} in the devflow Docker sandbox`)
	const child = spawn('docker', dockerArgs, {
		// The docker CLI needs the host's PATH, HOME (for its context config) and DOCKER_* settings.
		env: {
			...input.env,
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DOCKER_'))),
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	// Killing the docker CLI does not stop the container; stop it by name.
	const stop = () => {
		spawnSync('docker', ['kill', name], { stdio: 'ignore' })
	}
	return { child, stop }
}

/**
 * The environment a sandboxed Claude Code process gets: the allowlisted part of `env`, then its own
 * config directory and HOME.
 *
 * With a session GitHub account (`githubEnv`), the container acts only as that account: the
 * pointers come from `githubEnv` alone and every variable that would override them is dropped. With
 * none, the pointers are dropped instead, so a host-login session gets exactly the variables it
 * always did.
 */
export function sandboxEnvironment(
	env: Readonly<Record<string, string | undefined>>,
	input: { readonly configDir: string; readonly githubEnv: GithubEnv | null },
): Record<string, string> {
	const allowed: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && ENV_ALLOW.test(key) && !DEVFLOW_SECRET_ENV.test(key)) allowed[key] = value
	}
	const result: Record<string, string> =
		input.githubEnv === null
			? Object.fromEntries(
					Object.entries(allowed).filter(
						([key]) => !(GITHUB_CREDENTIAL_POINTERS as readonly string[]).includes(key),
					),
				)
			: withGithubEnvironment(allowed, input.githubEnv)
	result.CLAUDE_CONFIG_DIR = input.configDir
	result.HOME = join(input.configDir, 'home')
	return result
}

/** Host paths the session's GitHub credential directory needs mounted (at the same paths). */
export function githubCredentialMounts(githubEnv: GithubEnv | null): string[] {
	return githubEnv === null ? [] : [githubEnv.GH_CONFIG_DIR, dirname(githubEnv.GIT_CONFIG_GLOBAL)]
}

/** What a sandboxed Claude Code process is started with: its working directory, mounts and env. */
export function sandboxLaunch(
	options: Pick<SpawnOptions, 'cwd' | 'args' | 'env'>,
	input: {
		readonly cwd: string
		readonly mountPaths: readonly (string | undefined)[]
		readonly githubEnv?: GithubEnv | null
	},
): { readonly cwd: string; readonly mounts: (string | undefined)[]; readonly env: Record<string, string> } {
	const cwd = options.cwd ?? input.cwd
	const configDir = sandboxClaudeConfigDir()
	mkdirSync(join(configDir, 'home'), { recursive: true })
	const githubEnv = input.githubEnv ?? null

	const mounts = [
		...sandboxMountPaths({ cwd, mountPaths: input.mountPaths, githubEnv }),
		...argumentPaths(options.args),
	]
	return { cwd, mounts, env: sandboxEnvironment(options.env, { configDir, githubEnv }) }
}

/**
 * Host paths every sandboxed agent needs at the same path: its working directory, the sandbox's Claude
 * config, `mountPaths`, the session's GitHub credentials and the repository's shared git directory.
 */
export function sandboxMountPaths(input: {
	readonly cwd: string
	readonly mountPaths: readonly (string | undefined)[]
	readonly githubEnv: GithubEnv | null
}): (string | undefined)[] {
	return [
		input.cwd,
		sandboxClaudeConfigDir(),
		...input.mountPaths,
		...githubCredentialMounts(input.githubEnv),
		gitCommonDir(input.cwd),
		// Sibling worktrees of a multi-repository task: git follows each one's .git file to its own repository.
		...input.mountPaths.map((path) => (path && isLinkedWorktree(path) ? gitCommonDir(path) : undefined)),
	]
}

/** A linked worktree has a .git file (pointing at its repository) rather than a .git directory. */
function isLinkedWorktree(path: string): boolean {
	const dotGit = join(path, '.git')
	return existsSync(dotGit) && statSync(dotGit).isFile()
}

/** Plugin directories, settings and MCP config files appear as absolute paths in the CLI args. */
export function argumentPaths(args: readonly string[]): string[] {
	const paths: string[] = []
	for (const arg of args) {
		for (const piece of arg.split('=')) {
			if (isAbsolute(piece) && existsSync(piece)) {
				paths.push(statSync(piece).isDirectory() ? piece : dirname(piece))
			}
		}
	}
	return paths
}

export function createDockerSandboxSpawner(input: {
	readonly cwd: string
	readonly mountPaths: readonly (string | undefined)[]
	/** The session's GitHub credential directory, mounted and pointed at; null keeps the host login. */
	readonly githubEnv?: GithubEnv | null
}): (options: SpawnOptions) => SpawnedProcess {
	return (options) => {
		const { cwd, mounts, env } = sandboxLaunch(options, input)

		const { child, stop } = runInSandbox({
			label: 'Claude Code',
			cwd,
			mounts,
			env,
			command: ['claude', ...options.args],
		})
		child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[sandbox] ${chunk.toString()}`))
		options.signal?.addEventListener('abort', stop, { once: true })
		const kill = child.kill.bind(child)
		child.kill = (signal?: NodeJS.Signals | number) => {
			stop()
			return kill(signal)
		}
		return child as unknown as SpawnedProcess
	}
}

/** Git directory shared by all worktrees of the repository at `cwd` (mounted so commits work). */
export { gitCommonDir }

/**
 * Remove agent containers left by a daemon that died without cleaning up (run at startup). Any
 * project can pick the Docker sandbox, so this runs whenever a docker CLI answers.
 */
export function removeStaleSandboxContainers(): void {
	const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`], { encoding: 'utf8' })
	if (listed.status !== 0 || typeof listed.stdout !== 'string') return
	const ids = listed.stdout.split('\n').filter(Boolean)
	if (ids.length === 0) return
	spawnSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' })
	logger.info({ count: ids.length }, 'Removed stale devflow sandbox containers')
}
