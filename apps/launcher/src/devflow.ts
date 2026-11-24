#!/usr/bin/env bun
/**
 * devflow stack manager. Runs the devflow stack (API, Electric proxy, UI, daemon) for one local user.
 *
 *   bun run devflow setup    keys + config, containers, migrations, seed (safe to re-run)
 *   bun run devflow up       containers, Caddy (HTTPS + HTTP/2), API, sync proxy, daemon and the built UI
 *   bun run devflow up --dev same, with the UI on the Vite dev server (hot reload)
 *   bun run devflow down     stop containers (data volumes are kept)
 *   bun run devflow status   print URLs and container state
 *   bun run devflow env      print the generated environment
 *   bun run devflow up --headless       on the AWS VM: no Caddy, daemon talks to the API directly
 *   bun run devflow aws push|tunnel ... deploy to / connect to the VM (infra/terraform/README.md)
 *   bun run devflow e2e      Playwright end-to-end tests against the running stack
 *   bun run devflow <other>  devflow's CLI against this stack, e.g. `bun run devflow api --help`
 *
 * Config, keys and logs live in DEVFLOW_HOME (default ~/.devflow).
 */
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Effect, Layer } from 'effect'

import { renderStackEnvLines, type StackEnvProjection } from './lib/env-block'
import { OrganizationSeed, OrganizationSeedLive, OrganizationSeedPersistenceLive } from './lib/seed'

// ---- Options (edit here) ----------------------------------------------------
const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const DEVFLOW_HOME = process.env.DEVFLOW_HOME ?? join(homedir(), '.devflow')
const STACK_ID = 'devflow'
// Caddy terminates TLS for every route on this one port (SNI picks the backend).
const HTTPS_PORT = Number(process.env.DEVFLOW_HTTPS_PORT ?? 47443)
const HTTP_PORT = Number(process.env.DEVFLOW_HTTP_PORT ?? 47080)
const AGENT_IMAGE = process.env.DEVFLOW_AGENT_IMAGE ?? 'devflow-agent:latest'
const PORTS = {
	ui: 47000,
	cloud: 47001,
	api: 47100,
	electricProxy: 47101,
	docs: 47102,
	adminApi: 47103,
	adminUi: 47104,
	postgres: 47432,
	electric: 47300,
	rivetEngine: 47640,
	rivetServices: 47642,
	minioApi: 47900,
	minioConsole: 47901,
	tanstackDevtools: 47070,
	testPostgres: 47433,
	testElectric: 47301,
	testRivetEngine: 47641,
	testRivetServices: 47643,
} as const
const REDIS_PORT = 47379
// Dev servers started by `up --dev` (turbo filters).
// The UI runs as a production build served by `vite preview` unless `up --dev` asks for hot reload.
const DEV_PACKAGES = ['@devflow/api', '@devflow/sync-proxy', '@devflow/agent-runner']
const UI_PACKAGE = '@devflow/web'
// How often `up` runs apps/session-sweeper.
const SWEEP_INTERVAL_MS = 60_000
const UI_DIR = 'apps/web'
// A UI build is stale when any of these is newer than dist/index.html.
const UI_SOURCES = ['apps/web/src', 'apps/web/index.html', 'apps/web/vite.config.ts', 'packages/ui/src']
// -----------------------------------------------------------------------------

const CONFIG_PATH = join(DEVFLOW_HOME, 'config.json')
const KEYS_DIR = join(DEVFLOW_HOME, 'keys')
const LOG_DIR = join(DEVFLOW_HOME, 'logs')
const CADDYFILE_PATH = join(DEVFLOW_HOME, 'Caddyfile')

type DevflowConfig = {
	organizationId: string
	workosOrganizationId: string
	userId: string
	userEmail: string
	userName: string
	postgresPassword: string
	electricSecret: string
}

// GitHub API base URL when no GitHub App is configured: a closed local port, so GitHub calls fail
// fast and no request leaves the machine.
const OFFLINE_API_BASE_URL = 'http://127.0.0.1:9'

const route = (host: string) => `https://${host}.${STACK_ID}.localhost:${HTTPS_PORT}`
const ROUTES = { ui: route('app'), api: route('api'), sync: route('sync'), s3: route('s3') }

function loadOrCreateConfig(): DevflowConfig {
	mkdirSync(DEVFLOW_HOME, { recursive: true, mode: 0o700 })
	if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as DevflowConfig
	const gitName = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout.trim()
	const gitEmail = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8' }).stdout.trim()
	const config: DevflowConfig = {
		organizationId: randomUUID(),
		workosOrganizationId: 'org_devflow_local',
		userId: 'user_devflow_local',
		userEmail: gitEmail || 'me@devflow.localhost',
		userName: gitName || 'devflow user',
		postgresPassword: randomBytes(18).toString('base64url'),
		electricSecret: randomBytes(24).toString('base64url'),
	}
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
	return config
}

/** RSA pair for daemon tokens and an RSA JWK that signs local user tokens (both RS256). */
function ensureKeys(): { daemonPrivate: string; daemonPublic: string; userJwkPath: string; githubPlaceholder: string } {
	mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 })
	const privatePath = join(KEYS_DIR, 'daemon-token-private.pem')
	const publicPath = join(KEYS_DIR, 'daemon-token-public.pem')
	if (!existsSync(privatePath)) {
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
		writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
		writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
	}
	const userJwkPath = join(KEYS_DIR, 'user-auth-rs256.jwk.json')
	if (!existsSync(userJwkPath)) {
		// RS256, the algorithm the JWKS importers in the API and sync proxy expect.
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
		const jwk = { ...privateKey.export({ format: 'jwk' }), kid: `devflow-${randomUUID()}`, alg: 'RS256' }
		writeFileSync(userJwkPath, `${JSON.stringify(jwk)}\n`, { mode: 0o600 })
	}
	const githubPlaceholderPath = join(KEYS_DIR, 'github-app-placeholder.pem')
	if (!existsSync(githubPlaceholderPath)) {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
		writeFileSync(githubPlaceholderPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
	}
	return {
		githubPlaceholder: readFileSync(githubPlaceholderPath, 'utf8'),
		daemonPrivate: readFileSync(privatePath).toString('base64'),
		daemonPublic: readFileSync(publicPath).toString('base64'),
		userJwkPath,
	}
}

function buildEnv(config: DevflowConfig): Record<string, string> {
	const keys = ensureKeys()
	const composeProject = STACK_ID
	const postgresUrl = `postgresql://postgres:${encodeURIComponent(config.postgresPassword)}@127.0.0.1:${PORTS.postgres}/electric?sslmode=disable`
	const redisUrl = `redis://127.0.0.1:${REDIS_PORT}`
	const projection: StackEnvProjection = {
		id: STACK_ID,
		composeProject,
		ports: { ...PORTS },
		postgres: {
			postgresPort: PORTS.postgres,
			postgresPassword: config.postgresPassword,
			postgresVolume: `${composeProject}_postgresql_data`,
			databaseUrl: postgresUrl,
			readReplicaDatabaseUrl: postgresUrl,
		},
		api: { port: PORTS.api, route: ROUTES.api },
		electric: {
			electricPort: PORTS.electric,
			electricProxyPort: PORTS.electricProxy,
			electricSecret: config.electricSecret,
			electricReplicationStreamId: STACK_ID,
			shapeUrl: `http://127.0.0.1:${PORTS.electric}/v1/shape`,
			syncRoute: ROUTES.sync,
		},
		rivet: {
			enginePort: PORTS.rivetEngine,
			servicesPort: PORTS.rivetServices,
			engineVolume: `${composeProject}_durable-streams-data`,
			durableStreamsOrigin: `http://127.0.0.1:${PORTS.rivetServices}`,
		},
		minio: {
			apiPort: PORTS.minioApi,
			consolePort: PORTS.minioConsole,
			volume: `${composeProject}_minio_data`,
			bucket: 'devflow-artifacts',
			accessKeyId: 'minioadmin',
			secretAccessKey: 'minioadmin',
			endpoint: ROUTES.s3,
		},
		redis: { port: REDIS_PORT, volume: `${composeProject}_redis`, url: redisUrl },
		routes: { ui: ROUTES.ui, s3: ROUTES.s3 },
	}
	const lines = renderStackEnvLines(projection, join(DEVFLOW_HOME, 'registry.json'), config.organizationId)
	const env: Record<string, string> = {}
	for (const line of lines) {
		const index = line.indexOf('=')
		env[line.slice(0, index)] = line.slice(index + 1)
	}
	Object.assign(env, {
		LOG_BASE: LOG_DIR,
		STAGE: 'local',
		NODE_USE_SYSTEM_CA: '1',
		// Single-user auth (apps/api/src/devflow/local-auth.ts)
		DEVFLOW_LOCAL_AUTH: 'true',
		DEVFLOW_USER_ID: config.userId,
		DEVFLOW_USER_EMAIL: config.userEmail,
		DEVFLOW_USER_NAME: config.userName,
		DEVFLOW_ORGANIZATION_ID: config.organizationId,
		DEVFLOW_WORKOS_ORGANIZATION_ID: config.workosOrganizationId,
		DEVFLOW_AUTH_PRIVATE_JWK_PATH: keys.userJwkPath,
		DEVFLOW_JWKS_URL: `http://127.0.0.1:${PORTS.api}/devflow/auth/jwks`,
		VITE_PUBLIC_DEVFLOW_LOCAL_AUTH: 'true',
		// Helper model calls (titles, next steps) run through Claude Code on the subscription.
		DEVFLOW_AI_PROVIDER: 'claude-code',
		DEVFLOW_HOME,
		// Agents run in Docker containers (apps/agent-runner/src/devflow/docker-sandbox.ts);
		// set DEVFLOW_AGENT_SANDBOX=none in .env to run them on the host.
		DEVFLOW_AGENT_SANDBOX: process.env.DEVFLOW_AGENT_SANDBOX ?? 'docker',
		DEVFLOW_AGENT_IMAGE: AGENT_IMAGE,
		S3_ARTIFACTS_REGION: 'us-east-1',
		// Daemon: self-signed identity for the local user (DEVFLOW_DAEMON_LOAD_CREDS dev path).
		DEVFLOW_DAEMON_TOKEN_PRIVATE_KEY: keys.daemonPrivate,
		DEVFLOW_DAEMON_TOKEN_PUBLIC_KEY: keys.daemonPublic,
		DEVFLOW_DAEMON_LOAD_CREDS: 'true',
		DEVFLOW_DAEMON_USER_ID: config.userId,
		DEVFLOW_DAEMON_ORGANIZATION_ID: config.organizationId,
		DEVSTACK_REDIS_PORT: String(REDIS_PORT),
	})
	// GitHub App (PR status, webhooks). Set GITHUB_APP_* in .env to use your own App; without it
	// the API starts with a placeholder key and GitHub App features stay off.
	const githubApp = {
		GITHUB_APP_ID: 'devflow_disabled',
		GITHUB_APP_CLIENT_ID: 'devflow_disabled',
		GITHUB_APP_SLUG: 'devflow_disabled',
		GITHUB_APP_WEBHOOK_SECRET: 'devflow_disabled',
		GITHUB_APP_PRIVATE_KEY: keys.githubPlaceholder,
	}
	for (const [key, value] of Object.entries(githubApp)) env[key] = process.env[key] ?? value
	// Sandboxed agents push branches and open PRs with gh; give them the host's gh login token.
	if (env.DEVFLOW_AGENT_SANDBOX === 'docker' && !process.env.GH_TOKEN) {
		const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
		if (token.status === 0 && token.stdout.trim()) env.GH_TOKEN = token.stdout.trim()
	}
	if (!process.env.GITHUB_APP_ID) env.GITHUB_API_BASE_URL = OFFLINE_API_BASE_URL
	return env
}

function run(command: string, args: string[], env: Record<string, string>, options: { cwd?: string } = {}): void {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? REPO_ROOT,
		env: { ...process.env, ...env },
		stdio: 'inherit',
	})
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function compose(env: Record<string, string>, args: string[]): void {
	run('docker', ['compose', '-f', join(REPO_ROOT, 'docker-compose.yaml'), ...args], env)
}

const CONTAINER_SERVICES = ['postgres', 'electric', 'minio', 'minio-setup', 'durable-streams', 'redis']

/** Build the agent sandbox image (docker/devflow-agent) when the sandbox is on and the image is missing. */
function ensureAgentImage(env: Record<string, string>): void {
	if (env.DEVFLOW_AGENT_SANDBOX !== 'docker') return
	const present = spawnSync('docker', ['image', 'inspect', AGENT_IMAGE], { stdio: 'ignore' }).status === 0
	if (present) return
	console.log(`Building the agent sandbox image ${AGENT_IMAGE} (about 1 minute)...`)
	run('docker', ['build', '-t', AGENT_IMAGE, join(REPO_ROOT, 'docker/devflow-agent')], {})
}

function writeCaddyfile(): void {
	// Same route block as apps/launcher/src/lib/caddy.ts renderCaddyConfig, on one non-default port.
	const block = (url: string, port: number) =>
		`${url} {\n\treverse_proxy 127.0.0.1:${port} {\n\t\tflush_interval -1\n\t}\n\theader Cache-Control "no-cache, no-transform"\n\theader X-Accel-Buffering "no"\n}`
	const config = [
		`{\n\thttp_port ${HTTP_PORT}\n\thttps_port ${HTTPS_PORT}\n\tskip_install_trust\n\tlog {\n\t\tlevel WARN\n\t}\n}`,
		block(ROUTES.ui, PORTS.ui),
		block(ROUTES.api, PORTS.api),
		block(ROUTES.sync, PORTS.electricProxy),
		block(ROUTES.s3, PORTS.minioApi),
	].join('\n\n')
	writeFileSync(CADDYFILE_PATH, `# Generated by apps/launcher/src/devflow.ts. Do not edit.\n\n${config}\n`)
}

function uiBuildIsStale(): boolean {
	const builtIndex = join(REPO_ROOT, UI_DIR, 'dist/index.html')
	if (!existsSync(builtIndex)) return true
	const newer = spawnSync(
		'find',
		[...UI_SOURCES.map((path) => join(REPO_ROOT, path)), '-newer', builtIndex, '-print', '-quit'],
		{
			encoding: 'utf8',
		},
	)
	return newer.stdout.trim().length > 0
}

function requireTool(name: string): void {
	const found = spawnSync('which', [name], { encoding: 'utf8' })
	if (found.status !== 0) throw new Error(`\`${name}\` is not on PATH. Run inside \`nix develop\`.`)
}

async function waitForPostgres(env: Record<string, string>): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const ready = spawnSync(
			'docker',
			[
				'compose',
				'-f',
				join(REPO_ROOT, 'docker-compose.yaml'),
				'exec',
				'-T',
				'postgres',
				'pg_isready',
				'-U',
				'postgres',
			],
			{ env: { ...process.env, ...env }, stdio: 'ignore' },
		)
		if (ready.status === 0) return
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error('Postgres did not become ready within 60s')
}

async function setup(): Promise<void> {
	requireTool('docker')
	const config = loadOrCreateConfig()
	const env = buildEnv(config)
	mkdirSync(LOG_DIR, { recursive: true })
	compose(env, ['up', '-d', '--wait', ...CONTAINER_SERVICES.filter((service) => service !== 'minio-setup')])
	compose(env, ['up', '-d', 'minio-setup'])
	await waitForPostgres(env)
	ensureAgentImage(env)
	run('bun', ['--bun', 'x', 'drizzle-kit', 'migrate'], env, { cwd: join(REPO_ROOT, 'packages/db') })
	await Effect.runPromise(
		Effect.gen(function* () {
			const seed = yield* OrganizationSeed
			yield* seed.seed({
				databaseUrl: env.DATABASE_URL!,
				organization: {
					id: config.organizationId,
					workosOrganizationId: config.workosOrganizationId,
					name: 'devflow',
				},
			})
		}).pipe(Effect.provide(OrganizationSeedLive.pipe(Layer.provide(OrganizationSeedPersistenceLive)))),
	)
	writeCaddyfile()
	console.log(`\ndevflow is set up. Start it with: bun run devflow up\nThen open ${ROUTES.ui}`)
}

// Long-running processes for `up`. Same entry points and flags as each package's `dev` script,
// minus `--watch` (a watched process that fails to bind its port stays alive as an orphan).
const SERVICES: Array<{ name: string; cwd: string; args: string[]; env?: Record<string, string> }> = [
	{ name: 'api', cwd: 'apps/api', args: ['--bun', 'src/index.ts'] },
	{ name: 'sync', cwd: 'apps/sync-proxy', args: ['src/index.ts'] },
	{
		name: 'daemon',
		cwd: 'apps/agent-runner',
		args: ['--bun', 'src/daemon.ts'],
		env: { DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: 'true' },
	},
]

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const ok = await fetch(url, { signal: AbortSignal.timeout(2000) })
			.then((response) => response.ok)
			.catch(() => false)
		if (ok) return
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error(`${url} did not respond within ${timeoutMs / 1000}s`)
}

function listeningPids(port: number): number[] {
	const result = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
	return result.stdout.split('\n').filter(Boolean).map(Number)
}

/** Forward a child's output with a `[name]` prefix so the four services stay readable in one terminal. */
function prefixOutput(child: ReturnType<typeof spawn>, name: string): void {
	for (const stream of [child.stdout, child.stderr]) {
		let pending = ''
		stream?.on('data', (chunk: Buffer) => {
			const lines = (pending + chunk.toString()).split('\n')
			pending = lines.pop() ?? ''
			for (const line of lines) process.stdout.write(`[${name}] ${line}\n`)
		})
	}
}

async function up(): Promise<void> {
	// Headless (the AWS VM): no Caddy here; the laptop runs Caddy in front of `aws tunnel`.
	const headless = process.argv.includes('--headless')
	requireTool('docker')
	if (!headless) requireTool('caddy')
	const busy = [PORTS.ui, PORTS.api, PORTS.electricProxy, HTTPS_PORT].filter((port) => listeningPids(port).length > 0)
	if (busy.length > 0) {
		throw new Error(`Ports ${busy.join(', ')} are in use. Stop the other devflow (or the process on them) first.`)
	}
	if (!existsSync(CONFIG_PATH)) await setup()
	const config = loadOrCreateConfig()
	const env = buildEnv(config)
	mkdirSync(LOG_DIR, { recursive: true })
	compose(env, ['up', '-d', '--wait', ...CONTAINER_SERVICES.filter((service) => service !== 'minio-setup')])
	writeCaddyfile()
	ensureAgentImage(env)
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
	if (headless) {
		// The daemon reaches the API and sync proxy directly; only browsers go through Caddy.
		childEnv.DEVFLOW_DAEMON_API_ORIGIN = `http://127.0.0.1:${PORTS.api}`
		childEnv.DEVFLOW_DAEMON_SYNC_ORIGIN = `http://127.0.0.1:${PORTS.electricProxy}`
	}
	const devUi = process.argv.includes('--dev')
	if (!devUi && uiBuildIsStale()) {
		console.log('Building the UI (about 40s; skipped while sources are unchanged)...')
		run('bun', ['--bun', 'x', 'vite', 'build', '--logLevel', 'error'], env, { cwd: join(REPO_ROOT, UI_DIR) })
	}

	// Every child leads its own process group (detached), so stopping a group also stops what it
	// started, e.g. the daemon's agent processes.
	const children = new Map<ReturnType<typeof spawn>, string>()
	let stopping = false
	let fatal: ((reason: string) => void) | null = null
	const fatalExit = new Promise<string>((resolveFatal) => {
		fatal = resolveFatal
	})
	// A service that exits on its own is restarted after 2s, as systemd's Restart=on-failure would.
	// Three exits within 10s of starting means it cannot run, so the whole stack stops.
	const start = (
		name: string,
		command: string,
		args: string[],
		cwd: string,
		extraEnv: Record<string, string> = {},
		quickExits = 0,
	) => {
		const startedAt = Date.now()
		const child = spawn(command, args, {
			cwd: join(REPO_ROOT, cwd),
			env: { ...childEnv, ...extraEnv },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		})
		prefixOutput(child, name)
		children.set(child, name)
		child.once('exit', (code, signal) => {
			children.delete(child)
			if (stopping) return
			const quick = Date.now() - startedAt < 10_000 ? quickExits + 1 : 0
			if (quick >= 3) {
				fatal?.(`${name} exited ${quick} times right after starting (last: ${signal ?? code})`)
				return
			}
			console.error(`[devflow] ${name} exited (${signal ?? code}); restarting in 2s`)
			setTimeout(() => {
				if (!stopping) start(name, command, args, cwd, extraEnv, quick)
			}, 2000)
		})
		return child
	}
	if (!headless) start('caddy', 'caddy', ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], '.')
	if (devUi) {
		// Hot-reload mode: the packages' own `dev` scripts through turbo.
		const packages = [...DEV_PACKAGES, UI_PACKAGE]
		start(
			'turbo',
			'bun',
			[
				'--bun',
				'x',
				'turbo',
				'run',
				'dev',
				...packages.flatMap((name) => ['--filter', name]),
				'--env-mode=loose',
			],
			'.',
		)
	} else {
		// The sync proxy and daemon fetch the API's JWKS and call its RPC routes at startup.
		const [api, ...rest] = SERVICES
		start(api!.name, 'bun', api!.args, api!.cwd, api!.env)
		await waitForHttp(`http://127.0.0.1:${PORTS.api}/devflow/auth/jwks`, 60_000).catch((error: unknown) => {
			for (const child of children.keys()) if (child.pid) process.kill(-child.pid, 'SIGKILL')
			throw error
		})
		for (const service of rest) start(service.name, 'bun', service.args, service.cwd, service.env)
		start(
			'ui',
			'bun',
			['--bun', 'x', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORTS.ui), '--strictPort'],
			UI_DIR,
		)
	}

	// Marks silent hosts offline and stalled sessions lost (session sweeper, run on a timer).
	let sweeping = false
	const sweep = () => {
		if (sweeping) return
		sweeping = true
		const child = spawn('bun', ['--bun', 'index.ts'], {
			cwd: join(REPO_ROOT, 'apps/session-sweeper'),
			env: childEnv,
			stdio: 'ignore',
		})
		child.once('exit', () => {
			sweeping = false
		})
	}
	const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS)
	console.log(`\ndevflow UI: ${ROUTES.ui}\n`)

	const signalGroups = (signal: NodeJS.Signals, only?: (name: string) => boolean) => {
		for (const [child, name] of children) {
			if (only && !only(name)) continue
			try {
				if (child.pid) process.kill(-child.pid, signal)
			} catch {
				// Group already gone.
			}
		}
	}
	// The daemon stops first, while the API is still up: its graceful shutdown records active
	// sessions as failed, denies pending approvals and marks the host offline through the API.
	const stop = async () => {
		if (stopping) return
		stopping = true
		clearInterval(sweeper)
		const daemons = [...children].filter(([, name]) => name === 'daemon').map(([child]) => child)
		signalGroups('SIGTERM', (name) => name === 'daemon')
		await Promise.race([
			Promise.all(daemons.map((child) => new Promise((done) => child.once('exit', done)))),
			new Promise((done) => setTimeout(done, 15_000)),
		])
		signalGroups('SIGTERM')
		// The API's graceful shutdown waits for open long-poll connections, so escalate after 10s.
		setTimeout(() => {
			signalGroups('SIGKILL')
			process.exit(130)
		}, 10_000).unref()
	}
	process.on('SIGINT', () => void stop())
	process.on('SIGTERM', () => void stop())
	const reason = await fatalExit
	if (!stopping) {
		console.error(`[devflow] ${reason}; stopping the others.`)
		await stop()
	}
}

function down(): void {
	const env = buildEnv(loadOrCreateConfig())
	compose(env, ['stop'])
}

function status(): void {
	const env = buildEnv(loadOrCreateConfig())
	console.log(`UI:   ${ROUTES.ui}\nAPI:  ${ROUTES.api}\nSync: ${ROUTES.sync}\nHome: ${DEVFLOW_HOME}\n`)
	compose(env, ['ps'])
}

function printEnv(): void {
	const env = buildEnv(loadOrCreateConfig())
	// Secret values are masked; the generated files under DEVFLOW_HOME hold the real ones.
	const secret = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY/
	for (const [key, value] of Object.entries(env)) console.log(`${key}=${secret.test(key) ? '<set>' : value}`)
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? undefined : process.argv[index + 1]
}

function requireOption(name: string): string {
	const value = option(name)
	if (!value) throw new Error(`Missing --${name}. See infra/terraform/README.md.`)
	return value
}

/**
 * `aws push`: upload the working tree (including uncommitted changes) to the bundle bucket and
 * run the VM's deploy script through SSM. `aws tunnel`: forward the VM's UI, API and sync ports
 * to this machine over SSM and serve them through the local Caddy at the usual HTTPS URLs.
 */
async function awsCommand(): Promise<void> {
	requireTool('aws')
	const sub = process.argv[3]
	const instance = requireOption('instance')
	const region = option('region') ?? process.env.AWS_REGION ?? 'us-east-1'
	if (sub === 'push') {
		const bucket = requireOption('bucket')
		const bundle = join(DEVFLOW_HOME, 'devflow.tar.gz')
		// `git stash create` snapshots uncommitted tracked changes without touching the working tree.
		const stash = spawnSync('git', ['stash', 'create'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()
		run('git', ['archive', '--format=tar.gz', '-o', bundle, stash || 'HEAD'], {})
		run('aws', ['s3', 'cp', bundle, `s3://${bucket}/devflow.tar.gz`, '--region', region], {})
		run(
			'aws',
			[
				'ssm',
				'send-command',
				'--region',
				region,
				'--instance-ids',
				instance,
				'--document-name',
				'AWS-RunShellScript',
				'--comment',
				'devflow deploy',
				'--parameters',
				'commands=["/opt/devflow/bin/deploy"]',
				'--output',
				'text',
				'--query',
				'Command.CommandId',
			],
			{},
		)
		console.log(
			`Deploy started on ${instance}. Then run: bun run devflow aws tunnel --instance ${instance} --region ${region}`,
		)
		return
	}
	if (sub === 'tunnel') {
		requireTool('caddy')
		requireTool('session-manager-plugin')
		writeCaddyfile()
		const children = [PORTS.ui, PORTS.api, PORTS.electricProxy].map((port) =>
			spawn(
				'aws',
				[
					'ssm',
					'start-session',
					'--region',
					region,
					'--target',
					instance,
					'--document-name',
					'AWS-StartPortForwardingSession',
					'--parameters',
					JSON.stringify({ portNumber: [String(port)], localPortNumber: [String(port)] }),
				],
				{ stdio: 'ignore' },
			),
		)
		children.push(
			spawn('caddy', ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], { stdio: 'inherit' }),
		)
		console.log(`Tunnel open. UI: ${ROUTES.ui} (Ctrl-C to close)`)
		const stop = () => {
			for (const child of children) child.kill('SIGTERM')
			process.exit(0)
		}
		process.on('SIGINT', stop)
		process.on('SIGTERM', stop)
		await new Promise<void>((resolveExit) => children[0]!.once('exit', () => resolveExit()))
		stop()
		return
	}
	throw new Error('Usage: bun run devflow aws push|tunnel --instance <id> [--bucket <name>] [--region <region>]')
}

/** `e2e`: Playwright tests in apps/e2e against the running stack (installed Chrome). */
function e2e(): void {
	const result = spawnSync('bun', ['x', 'playwright', 'test', ...process.argv.slice(3)], {
		cwd: join(REPO_ROOT, 'apps/e2e'),
		env: { ...process.env, DEVFLOW_HOME },
		stdio: 'inherit',
	})
	process.exit(result.status ?? 1)
}

const commands: Record<string, () => void | Promise<void>> = {
	e2e,
	setup,
	up,
	down,
	status,
	env: printEnv,
	aws: awsCommand,
}
/**
 * Every other command goes to devflow's CLI (apps/cli) against this stack, e.g.
 * `bun run devflow api tasks list`, `bun run devflow api sync sessions --task-id <id>`.
 */
function forwardToCli(args: string[]): void {
	const env = buildEnv(loadOrCreateConfig())
	const result = spawnSync('bun', ['--bun', 'src/index.ts', '--local', ...args], {
		cwd: join(REPO_ROOT, 'apps/cli'),
		env: { ...process.env, ...env },
		stdio: 'inherit',
	})
	process.exit(result.status ?? 1)
}

const command = process.argv[2] ?? 'up'
const handler = commands[command]
try {
	if (handler) await handler()
	else forwardToCli(process.argv.slice(2))
} catch (error) {
	console.error(`devflow ${command}: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
