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
 * The Codex thread id is stored as the session's coding_agent_session_id and resumed from there.
 */
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { Effect } from 'effect'

import { handleInterruptOutcome, subscribeToSessionInterrupt } from '@/agents/claudecode/interrupts'
import type { ForkMeta, SessionContext, SessionExecutor, SessionForExecution } from '@/agents/shared/run-session'
import { requestToolApproval } from '@/effects/services/claude-sessions/workflows/approvals'
import { withGithubEnvironment, type GithubEnv } from '@/effects/services/github-credentials/credential-files'
import { GithubCredentials } from '@/effects/services/github-credentials/github-credentials.service'
import { normalizePath } from '@/lib/utils'
import logger from '@/logger'

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
	private readonly notificationHandlers: Array<(method: string, params: Record<string, JsonValue>) => void> = []
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
				resolve(code)
			}
			// A missing `codex` binary emits `error` (code ENOENT) and may never emit `exit`.
			child.once('error', (error) => close(error, null))
			child.once('exit', (code) => close(new Error(`codex app-server exited (${code})`), code))
		})
	}

	onNotification(handler: (method: string, params: Record<string, JsonValue>) => void): void {
		this.notificationHandlers.push(handler)
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

	close(): void {
		this.child.stdin?.end()
		this.child.kill('SIGTERM')
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
		if (message.method)
			for (const handler of this.notificationHandlers) handler(message.method, message.params ?? {})
	}
}

/**
 * Start `codex app-server` on the host. Codex sandboxes its own commands (Seatbelt on macOS,
 * Landlock on Linux; `workspace-write` limits writes to the worktree), so it does not use the
 * Docker sandbox: that would need the user's whole CODEX_HOME (auth refresh rewrites auth.json by
 * rename) mounted into the container, including every past Codex session.
 */
export function startAppServer(cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
	return spawn('codex', ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
): Promise<{ readonly githubEnv: GithubEnv | null; readonly release: () => Promise<void> }> {
	const githubEnv = await services.daemonRuntime.runPromise(
		Effect.gen(function* () {
			const credentials = yield* GithubCredentials
			return yield* credentials.prepare({ sessionId: session.id, taskId: session.task_id, scope: 'host' })
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

export async function executeCodexAppServer(
	ctx: SessionContext,
	_resumeSessionId?: string,
	forkMeta?: ForkMeta,
): Promise<void> {
	if (forkMeta) throw new Error('Forking a Codex app-server session is not supported')
	const { session, services, interruptState } = ctx
	const { orpc } = services
	const cwd = normalizePath(session.working_directory)
	const bypass = session.permissions_mode === 'bypass'
	const prompt = session.prompt ?? ''

	// Fails the session rather than start Codex as some other GitHub identity.
	const github = await prepareCodexGithubCredentials(session, services)
	let client: AppServerClient
	try {
		client = new AppServerClient(startAppServer(cwd, codexEnvironment(github.githubEnv)))
	} catch (error) {
		await github.release()
		throw error
	}
	let threadId = session.coding_agent_session_id ?? ''
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

	const unsubscribeInterrupt = subscribeToSessionInterrupt({
		sessionId: session.id,
		interruptState,
		eventIterator: {
			interrupt: async () => {
				abort.abort()
				const turnId = currentTurnId
				if (threadId && turnId)
					await client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
			},
		},
		closeInputStream: undefined,
		sessionsCollection: services.collections.sessions,
	})

	let currentTurnId = ''
	try {
		await client.request('initialize', { clientInfo: { name: 'devflow', title: 'devflow', version: '1' } })
		client.notify('initialized')
		const threadSettings = {
			cwd,
			model: session.model ?? null,
			approvalPolicy: bypass ? 'never' : 'on-request',
			sandbox: bypass ? 'danger-full-access' : 'workspace-write',
			// Agents install dependencies and fetch docs, so the workspace sandbox keeps network access.
			config: { sandbox_workspace_write: { network_access: true } },
		}
		if (threadId) {
			await client.request('thread/resume', { threadId, ...threadSettings, excludeTurns: true })
		} else {
			const started = (await client.request('thread/start', threadSettings)) as { thread: { id: string } }
			threadId = started.thread.id
			await orpc.sessions.update({ sessionId: session.id, codingAgentSessionId: threadId })
		}
		await orpc.sessions.update({ sessionId: session.id, status: 'running' })
		await emit({ eventType: 'message', role: 'user', content: prompt })

		const effort =
			session.effort && ['low', 'medium', 'high', 'xhigh'].includes(session.effort) ? session.effort : null
		const started = (await client.request('turn/start', {
			threadId,
			input: [{ type: 'text', text: prompt, text_elements: [] }],
			...(effort ? { effort } : {}),
		})) as { turn: { id: string } }
		currentTurnId = started.turn.id
		logger.info({ sessionId: session.id, threadId, turnId: currentTurnId }, 'Codex app-server turn started')

		const turn = await Promise.race([
			turnDone,
			client
				.whenExited()
				.then((code) => ({ status: 'failed', error: { message: `codex app-server exited (${code})` } })),
		])
		await writes
		if (!(await Effect.runPromise(interruptState.wasInterrupted))) {
			if (turn.status === 'failed') {
				const message = (turn.error as { message?: string } | undefined)?.message ?? 'Codex turn failed'
				await orpc.sessions.update({ sessionId: session.id, status: 'failed', errorMessage: message })
			} else {
				await orpc.sessions.update({ sessionId: session.id, status: 'ready_for_input' })
			}
		}
	} catch (error) {
		if (!(await Effect.runPromise(interruptState.wasInterrupted))) throw error
	} finally {
		unsubscribeInterrupt()
		client.close()
		await github.release()
	}

	await handleInterruptOutcome({
		interruptState,
		sessionId: session.id,
		orpc,
		shutdown: services.shutdown,
		onResume: async (nextPrompt) => {
			const { runSession } = await import('@/agents/shared/run-session')
			await runSession({
				session: { ...session, prompt: nextPrompt, coding_agent_session_id: threadId },
				resumeSessionId: session.id,
				services,
				execute: executeCodexAppServer,
			})
		},
	})
}
