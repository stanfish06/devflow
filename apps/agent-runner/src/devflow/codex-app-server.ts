/**
 * devflow: run Codex sessions through the Codex CLI's JSON-RPC app-server (`codex app-server`).
 * Takes the `codelayer` executor slot for sessions whose provider is `codex`, so the UI's Codex
 * models, session rows and the daemon's launch, continue and interrupt handling stay unchanged.
 * Auth is the Codex CLI login (`codex login`, CODEX_HOME).
 *
 * Protocol (codex-cli 0.169): newline-delimited JSON messages without a `jsonrpc` field.
 * initialize -> initialized -> thread/start | thread/resume -> turn/start, then notifications
 * (`item/completed`, `turn/completed`) and server requests for approvals.
 *
 * Mapping to devflow's conversation events:
 *   agentMessage -> assistant message; reasoning -> thinking; commandExecution -> `bash` tool call
 *   and result; fileChange -> `apply_patch` call and result per file; mcpToolCall -> `mcp__s__t`.
 * A commandExecution whose output shows GitHub refusing the session's account stops the turn, and
 * the session fails with the reason the API gives (see GithubCredentials.reportRejection).
 * The Codex thread id is stored as the session's coding_agent_session_id and resumed from there.
 */
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { isSessionStatusAwaitingLaunch } from '@devflow/schemas/effect/session/session-status'
import { Effect } from 'effect'

import { getWorkflowRoutingContext } from '@/agents/claudecode/hooks/workflow-routing-hook'
import { handleInterruptOutcome, subscribeToSessionInterrupt } from '@/agents/claudecode/interrupts'
import type { ForkMeta, SessionContext, SessionExecutor, SessionForExecution } from '@/agents/shared/run-session'
import { isVmSandbox, sessionSandbox, waitForTaskSandbox, whileLaunching } from '@/devflow/agent-sandbox'
import { CodexSessionClosedError, CodexSessionProcesses } from '@/devflow/codex-session-processes'
import { DEVFLOW_SECRET_ENV, githubCredentialMounts, gitCommonDir } from '@/devflow/docker-sandbox'
import { vmManager, type VmLease } from '@/devflow/vm-sandbox'
import { requestToolApproval } from '@/effects/services/claude-sessions/workflows/approvals'
import { withGithubEnvironment, type GithubEnv } from '@/effects/services/github-credentials/credential-files'
import { GithubCredentials } from '@/effects/services/github-credentials/github-credentials.service'
import { matchGithubRejection } from '@/effects/services/github-credentials/rejection-signatures'
import { stopRunOnGithubRejection } from '@/effects/services/github-credentials/stop-on-github-rejection'
import { setupArtifactPaths } from '@/lib/artifact-paths'
import { createArtifactSyncLedger } from '@/lib/artifact-sync-ledger'
import { syncShellCreatedArtifacts } from '@/lib/artifact-sync-utils'
import { normalizePath } from '@/lib/utils'
import { isInGitWorktree } from '@/lib/workspace/detect-worktree'
import logger from '@/logger'
import { ensureRpiPluginOnDisk } from '@/plugins/ensure-plugin'

export function isCodexAppServerSession(session: Pick<SessionForExecution, 'provider'>): boolean {
	return session.provider === 'codex'
}

export const UNSUPPORTED_AGENT_MESSAGE = 'devflow runs Claude Code and Codex (codex app-server) only'

/** Executor for agents devflow does not run (Fold, non-Codex CodeLayer providers): fail the session. */
export const failUnsupportedAgent: SessionExecutor = async ({ session, services }) => {
	await services.orpc.sessions.update({
		sessionId: session.id,
		status: 'failed',
		errorMessage: UNSUPPORTED_AGENT_MESSAGE,
	})
}

/** The `codelayer` executor slot: Codex sessions run on the app-server, every other provider fails. */
export const executeCodelayerSlot: SessionExecutor = (ctx, resumeSessionId, forkMeta) =>
	isCodexAppServerSession(ctx.session)
		? executeCodexAppServer(ctx, resumeSessionId, forkMeta)
		: failUnsupportedAgent(ctx, resumeSessionId, forkMeta)

type JsonValue = unknown
type RpcMessage = {
	id?: number | string
	method?: string
	params?: Record<string, JsonValue>
	result?: Record<string, JsonValue>
	error?: { code?: number; message?: string }
}

/** Minimal client for the app-server's newline-delimited JSON-RPC over the child's stdio. */
export class AppServerClient {
	private nextId = 1
	private readonly pending = new Map<
		number,
		{ resolve: (v: RpcMessage['result']) => void; reject: (e: Error) => void }
	>()
	private notificationHandler?: (method: string, params: Record<string, JsonValue>) => void
	private exitHandler?: (code: number | null) => void
	private requestHandler: ((method: string, params: Record<string, JsonValue>) => Promise<JsonValue>) | null = null
	private readonly exited: Promise<number | null>
	/** Set once the process failed to spawn or exited; later requests reject with it. */
	private closedError: Error | null = null

	constructor(private readonly child: ChildProcess) {
		const lines = createInterface({ input: child.stdout! })
		lines.on('line', (line) => this.onLine(line))
		child.stderr?.on('data', (chunk: Buffer) =>
			logger.debug({ stderr: chunk.toString() }, 'codex app-server stderr'),
		)
		// Writes to a process that already exited fail with EPIPE; the exit handler reports it.
		child.stdin?.on('error', (error) => logger.debug({ error }, 'codex app-server stdin closed'))
		this.exited = new Promise((resolve) => {
			const close = (error: Error, code: number | null) => {
				if (this.closedError) return
				this.closedError = error
				for (const { reject } of this.pending.values()) reject(error)
				this.pending.clear()
				this.exitHandler?.(code)
				resolve(code)
			}
			// A missing `codex` binary emits `error` (code ENOENT) and may never emit `exit`.
			child.once('error', (error) => close(error, null))
			child.once('exit', (code) => close(new Error(`codex app-server exited (${code})`), code))
		})
	}

	onNotification(handler: (method: string, params: Record<string, JsonValue>) => void): void {
		this.notificationHandler = handler
	}

	onExit(handler: (code: number | null) => void): void {
		this.exitHandler = handler
	}

	clearTurnHandlers(): void {
		this.notificationHandler = undefined
		this.exitHandler = undefined
		this.requestHandler = null
	}

	onRequest(handler: (method: string, params: Record<string, JsonValue>) => Promise<JsonValue>): void {
		this.requestHandler = handler
	}

	request(method: string, params: Record<string, JsonValue>): Promise<RpcMessage['result']> {
		if (this.closedError) return Promise.reject(this.closedError)
		const id = this.nextId++
		const done = new Promise<RpcMessage['result']>((resolve, reject) => this.pending.set(id, { resolve, reject }))
		this.send({ id, method, params })
		return done
	}

	notify(method: string, params: Record<string, JsonValue> = {}): void {
		this.send({ method, params })
	}

	whenExited(): Promise<number | null> {
		return this.exited
	}

	close(graceful = false): void {
		if (this.closedError) return
		this.child.stdin?.end()
		if (!graceful) {
			this.child.kill('SIGTERM')
			return
		}
		// Allow a rollout flush, then finish escalation within the daemon's 2.5s session drain.
		const terminate = setTimeout(() => this.child.kill('SIGTERM'), 1_000)
		const kill = setTimeout(() => this.child.kill('SIGKILL'), 2_000)
		terminate.unref()
		kill.unref()
		void this.exited.then(() => {
			clearTimeout(terminate)
			clearTimeout(kill)
		})
	}

	private send(message: RpcMessage): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`)
	}

	private onLine(line: string): void {
		if (!line.trim()) return
		let message: RpcMessage
		try {
			message = JSON.parse(line) as RpcMessage
		} catch {
			logger.warn({ line: line.slice(0, 200) }, 'codex app-server sent a non-JSON line')
			return
		}
		// Response to one of our requests.
		if (message.id !== undefined && message.method === undefined) {
			const waiter = this.pending.get(Number(message.id))
			if (!waiter) return
			this.pending.delete(Number(message.id))
			if (message.error) waiter.reject(new Error(message.error.message ?? 'codex app-server error'))
			else waiter.resolve(message.result)
			return
		}
		// Server-to-client request (approvals): answer with the handler's result.
		if (message.id !== undefined && message.method) {
			const handler = this.requestHandler
			void (handler ? handler(message.method, message.params ?? {}) : Promise.reject(new Error('unhandled')))
				.then((result) => this.send({ id: message.id, result: result as Record<string, JsonValue> }))
				.catch((error: unknown) =>
					this.send({
						id: message.id,
						error: { code: -32601, message: error instanceof Error ? error.message : 'unhandled' },
					}),
				)
			return
		}
		if (message.method) this.notificationHandler?.(message.method, message.params ?? {})
	}
}

/**
 * Start `codex app-server` on the host. Codex sandboxes its own commands (Seatbelt on macOS,
 * Landlock on Linux; `workspace-write` limits writes to the worktree), so it does not use the
 * Docker sandbox: that would need the user's whole CODEX_HOME (auth refresh rewrites auth.json by
 * rename) mounted into the container, including every past Codex session. A task whose sandbox is
 * a VM runs it there instead (startVmAppServer), with CODEX_HOME mounted.
 */
export function startAppServer(cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
	return spawn('codex', ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
}

const codexHome = (env: NodeJS.ProcessEnv = process.env) => env.CODEX_HOME ?? join(homedir(), '.codex')

/**
 * What Codex in a VM needs of its task: the whole task workspace (every repository's worktree, not
 * only the default one it starts in) and each worktree's git directory. Claude Code gets the sibling
 * worktrees through the SDK's additional directories instead.
 */
export function taskWorkspaceMounts(
	cwd: string,
	workspacesRoot = join(process.env.DEVFLOW_HOME ?? join(homedir(), '.devflow'), 'workspaces'),
): string[] {
	const fromRoot = relative(workspacesRoot, cwd)
	if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || fromRoot === '')
		return [cwd, ...optional(gitCommonDir(cwd))]
	const workspace = join(workspacesRoot, fromRoot.split(sep)[0] ?? '')
	const worktrees = [
		workspace,
		...readdirSync(workspace, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(workspace, entry.name)),
	]
	return [
		workspace,
		...worktrees.flatMap((dir) => (existsSync(join(dir, '.git')) ? optional(gitCommonDir(dir)) : [])),
	]
}

const optional = (path: string | undefined): string[] => (path ? [path] : [])

/** What a Codex process in a VM gets of the daemon's env: Codex and OpenAI settings, git identity, devflow metadata. */
const VM_CODEX_ENV_ALLOW = /^(CODEX_|OPENAI_|DEVFLOW_|GIT_(AUTHOR|COMMITTER)_|GH_TOKEN$|RUST_LOG$)/

export function vmCodexEnvironment(
	githubEnv: GithubEnv | null,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const allowed: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && VM_CODEX_ENV_ALLOW.test(key) && !DEVFLOW_SECRET_ENV.test(key)) allowed[key] = value
	}
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(withGithubEnvironment(allowed, githubEnv))) {
		if (value !== undefined) result[key] = value
	}
	// The guest's HOME differs from the host's; point Codex at the mounted host login.
	result.CODEX_HOME = codexHome(env)
	return result
}

/** Start `codex app-server` in the leased VM; killing the returned process also stops it in the guest. */
export function startVmAppServer(lease: VmLease, cwd: string, githubEnv: GithubEnv | null): ChildProcess {
	const { child, stop } = lease.run({
		label: 'Codex',
		cwd,
		env: vmCodexEnvironment(githubEnv),
		command: ['codex', 'app-server'],
	})
	const kill = child.kill.bind(child)
	child.kill = (signal?: NodeJS.Signals | number) => {
		stop()
		return kill(signal)
	}
	return child
}

/**
 * The Codex process env for a session: the daemon's own, pointed at the session's GitHub account
 * when it has one. Codex runs on the host, so the account's gitconfig keeps the user's own global
 * git config underneath. Null keeps the host's own gh login and the env exactly as before.
 */
export function codexEnvironment(githubEnv: GithubEnv | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return withGithubEnvironment(env, githubEnv)
}

/**
 * Put the session's GitHub account in place for a Codex run. Returns its env (null: host login) and
 * a release to call once the app-server has stopped.
 */
async function prepareCodexGithubCredentials(
	session: Pick<SessionForExecution, 'id' | 'task_id'>,
	services: SessionContext['services'],
	scope: 'host' | 'sandbox',
): Promise<{ readonly githubEnv: GithubEnv | null; readonly release: () => Promise<void> }> {
	const githubEnv = await services.daemonRuntime.runPromise(
		Effect.gen(function* () {
			const credentials = yield* GithubCredentials
			return yield* credentials.prepare({ sessionId: session.id, taskId: session.task_id, scope })
		}),
	)
	let released = false
	return {
		githubEnv,
		release: async () => {
			// Host-login sessions are held too, so release every prepared session.
			if (released) return
			released = true
			await services.daemonRuntime.runPromise(
				Effect.gen(function* () {
					const credentials = yield* GithubCredentials
					yield* credentials.release(session.id)
				}),
			)
		},
	}
}

type CreateEvent = Parameters<SessionContext['services']['orpc']['sessions']['events']['create']>[0]

/** A notification field that should hold text, or '' when it holds anything else. */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The composer expands a selected slash command to "use the rpi:<name> skill". */
function requestedRpiSkill(prompt: string): string | undefined {
	const match = /^(?:use the \/?rpi:([a-z0-9-]+) skill|\/rpi:([a-z0-9-]+))(?=\s|$)/i.exec(prompt.trimStart())
	return (match?.[1] ?? match?.[2])?.toLowerCase()
}

/** Deliver handoff templates with the turn so an existing VM can use them even if its plugin mount is stale. */
async function loadCodexCompletionTemplates(base: string, skill: string): Promise<string> {
	const references = new Set(skill.match(/\{SKILLBASE\}\/references\/[\w-]+_final_answer[\w-]*\.md\b/g))
	if (references.size === 0) return ''
	const templates = await Promise.all(
		Array.from(references, async (reference) => {
			const path = reference.replace('{SKILLBASE}', () => base)
			return `${path}\n${await readFile(path, 'utf8')}`
		}),
	)
	return [
		'Devflow has loaded the following final answer templates for this skill. When its completion criteria are met, use the copy below selected by the skill and workflow routing.',
		...templates,
	].join('\n\n')
}

async function prepareCodexWorkflow(
	ctx: SessionContext,
	cwd: string,
	prompt: string,
	continuing: boolean,
	cold: boolean,
) {
	const { session, services } = ctx
	const taskId = session.task_id
	const task = taskId ? services.collections.tasks.get(taskId) : undefined
	const sync = taskId ? await services.syncService.ensureTaskSync(taskId, cwd) : null
	const slug = task?.slug ?? sync?.getTaskSlug()
	const artifacts = taskId && slug ? await setupArtifactPaths(cwd, taskId, slug, services.daemonRuntime) : null
	const requested = requestedRpiSkill(prompt)
	// Interrupt/resume can reuse the pre-invocation session snapshot. Read the persisted call on replies.
	const handoff = Boolean(session.handoff_source_session_id)
	const previous =
		handoff || (continuing && (cold || !requested))
			? await services.orpc.sessions.workflowSkill({
					sessionId: session.id,
					includeConversation: cold && continuing,
				})
			: null
	const context: string[] = []
	if (cold && handoff && slug) {
		const briefPath = `.devflow/tasks/${slug}/task.md`
		const brief = sync?.getCollection()?.toArray.find((artifact) => artifact.file_name === 'task.md')?.content
		// Larger briefs stay available in full through the task's mounted artifact directory.
		context.push(
			brief && brief.length <= 8192
				? `Original task brief (${briefPath}):\n${brief}`
				: `Read the original task brief at ${briefPath} when you need the task request.`,
		)
	}
	// The launch prompt already contains the frozen handoff transcript. On replies, restore
	// the recent exchanges even when neither provider recorded a workflow skill.
	if (cold && continuing && previous?.conversation.length) {
		context.push(
			'Recent Devflow conversation, oldest first. Use it to interpret the current user reply below.',
			JSON.stringify(previous.conversation),
		)
	}
	const skillName = requested ?? previous?.skill
	// A resumed turn can still reference files from the skill loaded on an earlier turn.
	const pluginPath =
		taskId || skillName || session.coding_agent_session_id ? await ensureRpiPluginOnDisk() : undefined
	let skill: { name: string; path: string; instructions: string } | undefined
	if (skillName && pluginPath) {
		const base = join(pluginPath, 'skills', skillName)
		const path = join(base, 'SKILL.md')
		const contents = await readFile(path, 'utf8')
		const name = `rpi:${skillName}`
		const routing = getWorkflowRoutingContext(
			task?.workflow_type ?? null,
			task?.worktree_timing ?? null,
			name,
			await isInGitWorktree(cwd),
		)
		const instructions = [
			`Devflow loaded ${name} from ${path}. Follow its instructions using your available tools. Where a named research agent is unavailable, perform its research with your own tools.`,
			contents.replaceAll('{SKILLBASE}', () => base),
			await loadCodexCompletionTemplates(base, contents),
			(skillName === 'create-prd' || skillName === 'iterate-prd') &&
				"Keep status: draft in the PRD's YAML frontmatter while drafting or revising it. An answer to an interview question or approval of an individual section continues the interview. Only when the user explicitly approves the whole PRD, save status: approved in its frontmatter, then return the skill's final answer template. Devflow starts the TDD in a new session.",
			!requested &&
				previous?.skill &&
				[
					`Use ${name} again for this turn. Continue from the last exchange and the existing task artifacts${slug ? ` in .devflow/tasks/${slug}` : ''}.`,
					continuing
						? "Apply the user's reply to the pending decision."
						: "Resume at the last exchange. If a question is pending, present it and wait for the user's answer.",
					"Preserve settled decisions in the artifact. During an unfinished interview, ask the next single unresolved question and wait for the user's answer. Follow the skill's completion criteria before offering the next phase.",
					'Follow an explicit request to pause, stop, or change direction.',
				].join(' '),
			routing,
		]
			.filter(Boolean)
			.join('\n\n')
		skill = { name, path, instructions }
	}
	const syncArtifacts =
		sync && taskId
			? (signal: AbortSignal) =>
					syncShellCreatedArtifacts({
						syncManager: sync.createSessionManager(session.id),
						sessionId: session.id,
						cwd,
						taskId,
						taskSlug: slug ?? null,
						ledger: createArtifactSyncLedger(),
						failOnUploadError: true,
						signal,
					})
			: undefined
	return { skill, context, pluginPath, artifacts, syncArtifacts }
}

type CodexProcess = {
	client: AppServerClient
	threadId: string | null
	github: Awaited<ReturnType<typeof prepareCodexGithubCredentials>>
	close(): Promise<void>
	whenExited(): Promise<number | null>
}

const codexProcesses = new CodexSessionProcesses<CodexProcess>()

export const closeCodexAppServer = (sessionId: string) => codexProcesses.forceClose(sessionId)
export const shutdownCodexAppServers = () => codexProcesses.shutdown()
export function retireCodexAppServer(sessionId: string): void {
	void codexProcesses
		.retire(sessionId)
		.catch((error: unknown) => logger.error({ error, sessionId }, 'Could not retire Codex app-server'))
}

async function openCodexProcess(
	ctx: SessionContext,
	cwd: string,
	sandbox: ReturnType<typeof sessionSandbox>,
	workflow: Awaited<ReturnType<typeof prepareCodexWorkflow>>,
	continuing: boolean,
	signal: AbortSignal,
): Promise<CodexProcess> {
	const { session, services } = ctx
	const { orpc } = services
	const inVm = isVmSandbox(sandbox)
	// Fails the session rather than start Codex as some other GitHub identity.
	const github = await prepareCodexGithubCredentials(session, services, inVm ? 'sandbox' : 'host')
	let lease: VmLease | null = null
	let client: AppServerClient
	try {
		signal.throwIfAborted()
		if (inVm) {
			// A later turn can select an RPI skill while this process still holds the same VM lease.
			const pluginPath = workflow.pluginPath ?? (await ensureRpiPluginOnDisk())
			signal.throwIfAborted()
			// The dispatcher marks a launch as launching and a continuation as running.
			const activeStatus = continuing ? 'running' : 'launching'
			lease = await whileLaunching(
				vmManager.acquire({
					scope: sandbox === 'vm-task' ? 'task' : 'shared',
					taskId: session.task_id,
					paths: [
						...taskWorkspaceMounts(cwd),
						codexHome(),
						...githubCredentialMounts(github.githubEnv),
						workflow.artifacts?.storagePath,
					],
					workflowPluginPath: pluginPath,
				}),
				// Only while still launching: a stop request must not be overwritten.
				() =>
					services.collections.sessions.get(session.id)?.status === activeStatus
						? orpc.sessions.update({ sessionId: session.id, status: activeStatus })
						: Promise.resolve(),
			)
			// Electric may still show the dispatching row until the daemon's status write arrives.
			const status = services.collections.sessions.get(session.id)?.status
			const awaitingDispatch =
				status && (continuing ? status === 'resuming' : isSessionStatusAwaitingLaunch(status))
			if (status !== activeStatus && !awaitingDispatch) {
				throw new Error('The session stopped while its VM was starting')
			}
		}
		signal.throwIfAborted()
		client = new AppServerClient(
			lease
				? startVmAppServer(lease, cwd, github.githubEnv)
				: startAppServer(cwd, codexEnvironment(github.githubEnv)),
		)
	} catch (error) {
		lease?.release()
		await github.release()
		throw error
	}
	return {
		client,
		threadId: null,
		github,
		whenExited: () => client.whenExited(),
		close: async () => {
			client.close(true)
			await client.whenExited()
			lease?.release()
			await github.release()
		},
	}
}

export async function executeCodexAppServer(
	ctx: SessionContext,
	resumeSessionId?: string,
	forkMeta?: ForkMeta,
): Promise<void> {
	if (forkMeta) throw new Error('Forking a Codex app-server session is not supported')
	const { session, services, interruptState } = ctx
	const { orpc } = services
	const cwd = normalizePath(session.working_directory)
	const bypass = session.permissions_mode === 'bypass'
	const prompt = session.prompt ?? ''

	// Codex sandboxes itself on the host; only a VM task moves it (the Docker sandbox is Claude's).
	const sandbox = sessionSandbox(
		session.task_id ? await waitForTaskSandbox((id) => services.collections.tasks.get(id), session.task_id) : null,
	)
	const inVm = isVmSandbox(sandbox)
	const continuing = resumeSessionId !== undefined
	const prepareWorkflow = (cold: boolean) => prepareCodexWorkflow(ctx, cwd, prompt, continuing, cold)
	let workflow: Awaited<ReturnType<typeof prepareWorkflow>> | undefined
	// The VM mounts and GitHub identity belong to the task that opened the process.
	const processScope = JSON.stringify([session.task_id, session.resource_owner_user_id, cwd, sandbox])
	const slot = await codexProcesses
		.acquire(
			session.id,
			async (signal) => {
				workflow = await prepareWorkflow(true)
				signal.throwIfAborted()
				return openCodexProcess(ctx, cwd, sandbox, workflow, continuing, signal)
			},
			processScope,
		)
		.catch((error: unknown) => {
			if (error instanceof CodexSessionClosedError) return null
			throw error
		})
	if (!slot) return
	const live = slot.process
	const { client, github } = live
	const warm = live.threadId !== null
	let threadId = live.threadId ?? session.coding_agent_session_id ?? ''
	const emit = (event: Omit<CreateEvent, 'sessionId' | 'codingAgentSessionId'>) =>
		orpc.sessions.events.create({ ...event, sessionId: session.id, codingAgentSessionId: threadId } as CreateEvent)

	// Approvals go through devflow's approval rows, so the UI's approval card works unchanged.
	const abort = new AbortController()
	client.onRequest(async (method, params) => {
		const itemId = String(params.itemId ?? '')
		if (method === 'item/commandExecution/requestApproval') {
			const result = await services.daemonRuntime.runPromise(
				requestToolApproval({
					sessionId: session.id,
					toolName: 'Bash',
					toolInput: { command: params.command ?? params.reason ?? '' },
					cwd,
					signal: abort.signal,
					toolUseID: itemId,
				}),
			)
			return { decision: result.behavior === 'allow' ? 'accept' : 'decline' }
		}
		if (method === 'item/fileChange/requestApproval') {
			const result = await services.daemonRuntime.runPromise(
				requestToolApproval({
					sessionId: session.id,
					toolName: 'Edit',
					toolInput: { file_path: params.grantRoot ?? cwd, reason: params.reason ?? '' },
					cwd,
					signal: abort.signal,
					toolUseID: itemId,
				}),
			)
			return { decision: result.behavior === 'allow' ? 'accept' : 'decline' }
		}
		throw new Error(`devflow does not handle ${method}`)
	})

	let resolveTurn: (turn: Record<string, JsonValue>) => void = () => {}
	const turnDone = new Promise<Record<string, JsonValue>>((resolve) => {
		resolveTurn = resolve
	})
	client.onExit((code) => resolveTurn({ status: 'failed', error: { message: `codex app-server exited (${code})` } }))
	// Events are written in order; a chain keeps them ordered while notifications arrive.
	let writes = Promise.resolve()
	const enqueue = (write: () => Promise<unknown>) => {
		writes = writes.then(write).then(
			() => undefined,
			(error: unknown) => logger.error({ sessionId: session.id, error }, 'Could not record a Codex event'),
		)
	}
	client.onNotification((method, params) => {
		if (method === 'turn/completed') {
			resolveTurn((params.turn ?? {}) as Record<string, JsonValue>)
			return
		}
		if (method !== 'item/completed') return
		const item = (params.item ?? {}) as Record<string, JsonValue>
		const id = String(item.id ?? '')
		switch (item.type) {
			case 'agentMessage':
				if (item.text)
					enqueue(() => emit({ eventType: 'message', role: 'assistant', content: String(item.text) }))
				break
			case 'reasoning': {
				const text = [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])].join('\n')
				if (text.trim()) enqueue(() => emit({ eventType: 'thinking', role: 'assistant', content: text }))
				break
			}
			case 'commandExecution':
				enqueue(async () => {
					await emit({
						eventType: 'tool_call',
						role: 'assistant',
						toolCallId: id,
						toolName: 'bash',
						toolInputJson: { command: item.command },
					})
					const output = String(item.aggregatedOutput ?? '')
					const exit =
						item.exitCode === null || item.exitCode === undefined ? '' : `\n[exit code ${item.exitCode}]`
					await emit({
						eventType: 'tool_result',
						role: 'user',
						toolResultForId: id,
						toolResultContent: `${output}${exit}`,
					})
				})
				// In the same ordered chain, so the turn's outcome waits for the verdict.
				stopOnGithubRejection(textOf(item.command), textOf(item.aggregatedOutput))
				break
			case 'fileChange':
				enqueue(async () => {
					const changes =
						(item.changes as Array<{ path: string; diff: string; kind: { type: string } }>) ?? []
					for (const [index, change] of changes.entries()) {
						const callId = `${id}:${index}`
						await emit({
							eventType: 'tool_call',
							role: 'assistant',
							toolCallId: callId,
							toolName: 'apply_patch',
							toolInputJson: { file_path: change.path, patch: change.diff, kind: change.kind?.type },
						})
						await emit({
							eventType: 'tool_result',
							role: 'user',
							toolResultForId: callId,
							toolResultContent: String(item.status ?? 'completed'),
						})
					}
				})
				break
			case 'mcpToolCall':
				enqueue(async () => {
					await emit({
						eventType: 'tool_call',
						role: 'assistant',
						toolCallId: id,
						toolName: `mcp__${String(item.server ?? 'mcp')}__${String(item.tool ?? 'tool')}`,
						toolInputJson: item.arguments ?? {},
					})
					await emit({
						eventType: 'tool_result',
						role: 'user',
						toolResultForId: id,
						toolResultContent: JSON.stringify(item.result ?? item.error ?? null),
					})
				})
				break
			default:
				break
		}
	})

	const interruptTurn = async () => {
		abort.abort()
		const turnId = currentTurnId
		if (threadId && turnId) await client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
	}

	/**
	 * Only a run pointed at a credential directory acts as an account GitHub can refuse; a
	 * host-login run keeps today's behaviour. On a confirmed refusal the turn is interrupted, and
	 * the interrupt state already holds why the session fails.
	 */
	function stopOnGithubRejection(command: string, output: string) {
		if (github.githubEnv === null) return
		const rejection = matchGithubRejection({ command, output })
		if (rejection === null) return
		enqueue(async () => {
			const stop = await services.daemonRuntime.runPromise(
				stopRunOnGithubRejection({ sessionId: session.id, rejection, interruptState }),
			)
			if (stop) await interruptTurn()
		})
	}

	let unsubscribeInterrupt: (() => void) | undefined
	let currentTurnId = ''
	let keepAlive = false
	try {
		workflow ??= await prepareWorkflow(false)
		if (slot.wasCancelled()) return
		unsubscribeInterrupt = subscribeToSessionInterrupt({
			sessionId: session.id,
			interruptState,
			eventIterator: { interrupt: interruptTurn },
			closeInputStream: undefined,
			sessionsCollection: services.collections.sessions,
		})

		if (!warm) {
			await client.request('initialize', { clientInfo: { name: 'devflow', title: 'devflow', version: '1' } })
			client.notify('initialized')
			const threadSettings = {
				cwd,
				model: session.model ?? null,
				approvalPolicy: bypass ? 'never' : 'on-request',
				// In a VM the VM is the boundary, and Codex's own sandbox would keep commands off its Docker socket.
				sandbox: bypass || inVm ? 'danger-full-access' : 'workspace-write',
				// Agents install dependencies and fetch docs, so the workspace sandbox keeps network access.
				config: {
					sandbox_workspace_write: {
						network_access: true,
						writable_roots: workflow.artifacts ? [workflow.artifacts.storagePath] : undefined,
					},
				},
			}
			if (threadId) {
				await client.request('thread/resume', { threadId, ...threadSettings, excludeTurns: true })
			} else {
				const started = (await client.request('thread/start', threadSettings)) as { thread: { id: string } }
				threadId = started.thread.id
				await orpc.sessions.update({ sessionId: session.id, codingAgentSessionId: threadId })
			}
			live.threadId = threadId
		}
		await orpc.sessions.update({ sessionId: session.id, status: 'running' })

		// Launch and continue already persist the user messages before dispatching this turn.
		const preamble = [workflow.skill?.instructions, ...workflow.context].filter(Boolean).join('\n\n')
		const turnInput = [{ type: 'text', text: prompt, text_elements: [] }]
		if (preamble) turnInput.unshift({ type: 'text', text: preamble + '\n\n', text_elements: [] })
		if (workflow.skill) {
			const { name, path } = workflow.skill
			// The API applies phase labels when it records a Skill call. Codex's adapter loaded it above.
			const toolCallId = crypto.randomUUID()
			await emit({
				eventType: 'tool_call',
				role: 'assistant',
				toolName: 'Skill',
				toolCallId,
				toolInputJson: { skill: name },
			})
			await emit({
				eventType: 'tool_result',
				role: 'user',
				toolResultForId: toolCallId,
				toolResultContent: `Loaded ${path}`,
			})
		}
		const started = (await client.request('turn/start', {
			threadId,
			input: turnInput,
			model: session.model ?? null,
			approvalPolicy: bypass ? 'never' : 'on-request',
			sandboxPolicy:
				bypass || inVm
					? { type: 'dangerFullAccess' }
					: {
							type: 'workspaceWrite',
							writableRoots: workflow.artifacts ? [cwd, workflow.artifacts.storagePath] : [cwd],
							networkAccess: true,
						},
			effort: session.effort || undefined,
		})) as { turn: { id: string } }
		currentTurnId = started.turn.id
		logger.info({ sessionId: session.id, threadId, turnId: currentTurnId }, 'Codex app-server turn started')

		const turn = await turnDone
		await writes
		if (slot.wasCancelled()) return
		if (!(await Effect.runPromise(interruptState.wasInterrupted))) {
			if (turn.status === 'failed') {
				const message = (turn.error as { message?: string } | undefined)?.message ?? 'Codex turn failed'
				await orpc.sessions.update({ sessionId: session.id, status: 'failed', errorMessage: message })
			} else {
				// The ready transition checks uploaded artifact frontmatter to launch the next phase.
				await workflow.syncArtifacts?.(abort.signal)
				if (!slot.wasCancelled() && !(await Effect.runPromise(interruptState.wasInterrupted))) {
					await orpc.sessions.update({ sessionId: session.id, status: 'ready_for_input' })
				}
			}
		}
		keepAlive = turn.status !== 'failed'
	} catch (error) {
		if (slot.wasCancelled()) return
		if (!(await Effect.runPromise(interruptState.wasInterrupted))) throw error
	} finally {
		unsubscribeInterrupt?.()
		abort.abort()
		client.clearTurnHandlers()
		await slot.release(!keepAlive)
	}

	await handleInterruptOutcome({
		interruptState,
		sessionId: session.id,
		orpc,
		shutdown: services.shutdown,
		onResume: async (nextPrompt) => {
			const { runSession } = await import('@/agents/shared/run-session')
			await runSession({
				session: {
					...(services.collections.sessions.get(session.id) ?? session),
					prompt: nextPrompt,
					coding_agent_session_id: threadId,
				},
				resumeSessionId: session.id,
				services,
				execute: executeCodexAppServer,
			})
		},
	})
}
