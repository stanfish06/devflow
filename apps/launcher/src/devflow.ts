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
 *   bun run devflow up --port 48443   same, on 48443 and the ports shifted with it (kept for later commands)
 *   bun run devflow remote <ssh-host>  run an agent runner on another machine as a host of this server
 *   bun run devflow host     agent runner only (what `remote` starts on the other machine)
 *   bun run devflow setup-vm build the base Lima VM for VM-sandbox tasks ahead of `up` (one-off)
 *   bun run devflow e2e      Playwright end-to-end tests against the running stack
 *   bun run devflow trust    trust Caddy's local CA in the browsers' NSS databases (also run by `up`)
 *   bun run devflow <other>  devflow's CLI against this stack, e.g. `bun run devflow api --help`
 *
 * Config, keys and logs live in DEVFLOW_HOME (default ~/.devflow).
 */
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Effect, Layer } from 'effect'

import { formatBytes, parseCleanArgs, planClean } from './lib/clean'
import { renderStackEnvLines, type StackEnvProjection } from './lib/env-block'
import { ensureEnvFileValue } from './lib/env-file'
import { REMOTE_STAGING } from './lib/install-remote-tree'
import { OrganizationSeed, OrganizationSeedLive, OrganizationSeedPersistenceLive } from './lib/seed'

// ---- Options (edit here) ----------------------------------------------------
const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const DEVFLOW_HOME = process.env.DEVFLOW_HOME ?? join(homedir(), '.devflow')
const STACK_ID = 'devflow'
const CONFIG_PATH = join(DEVFLOW_HOME, 'config.json')
// Caddy terminates TLS for every route on one port (SNI picks the backend). Every other port is
// this one's offset from 47443 applied to the base ports below, so `--port 48443` moves the whole
// stack to 48xxx.
const BASE_HTTPS_PORT = 47443
const BASE_PORTS = {
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
const HTTPS_PORT = (() => {
	// Resolved while the module loads, before the command's own error handling; report it the same way.
	try {
		return resolveHttpsPort()
	} catch (error) {
		console.error(`devflow: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
})()
const PORT_OFFSET = HTTPS_PORT - BASE_HTTPS_PORT
const HTTP_PORT = Number(process.env.DEVFLOW_HTTP_PORT ?? 47080 + PORT_OFFSET)
const AGENT_IMAGE = process.env.DEVFLOW_AGENT_IMAGE ?? 'devflow-agent:latest'
const PORTS = portsFor(HTTPS_PORT)
const REDIS_PORT = 47379 + PORT_OFFSET

/** The base ports shifted by `httpsPort`'s offset from 47443. */
function portsFor(httpsPort: number): { [K in keyof typeof BASE_PORTS]: number } {
	const offset = httpsPort - BASE_HTTPS_PORT
	return Object.fromEntries(Object.entries(BASE_PORTS).map(([name, port]) => [name, port + offset])) as {
		[K in keyof typeof BASE_PORTS]: number
	}
}

/**
 * The local stack's HTTPS port: `--port`, then
 * DEVFLOW_HTTPS_PORT, then the port saved by an earlier `up --port`, then 47443.
 */
function resolveHttpsPort(): number {
	const flag = option('port')
	if (flag) return parsePort(flag)
	if (process.env.DEVFLOW_HTTPS_PORT) return parsePort(process.env.DEVFLOW_HTTPS_PORT)
	if (existsSync(CONFIG_PATH)) {
		const saved = (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { httpsPort?: number }).httpsPort
		if (saved) return parsePort(saved)
	}
	return BASE_HTTPS_PORT
}
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
	/** Set by `up --port` / `setup --port`; every command uses it until another `--port`. */
	httpsPort?: number
}

// GitHub API base URL when no GitHub App is configured: a closed local port, so GitHub calls fail
// fast and no request leaves the machine.
const OFFLINE_API_BASE_URL = 'http://127.0.0.1:9'

const route = (host: string, httpsPort = HTTPS_PORT) => `https://${host}.${STACK_ID}.localhost:${httpsPort}`
const ROUTES = { ui: route('app'), api: route('api'), sync: route('sync'), s3: route('s3') }

function loadOrCreateConfig(): DevflowConfig {
	mkdirSync(DEVFLOW_HOME, { recursive: true, mode: 0o700 })
	if (existsSync(CONFIG_PATH)) {
		const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as DevflowConfig
		// Keep the port from `--port` for later commands; 47443 is the default and needs no entry.
		const httpsPort = HTTPS_PORT === BASE_HTTPS_PORT ? undefined : HTTPS_PORT
		if (option('port') && config.httpsPort !== httpsPort) {
			const updated = { ...config, httpsPort }
			writeFileSync(CONFIG_PATH, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
			return updated
		}
		return config
	}
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
	if (HTTPS_PORT !== BASE_HTTPS_PORT) config.httpsPort = HTTPS_PORT
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
		DEVFLOW_USER_ID: config.userId,
		DEVFLOW_USER_EMAIL: config.userEmail,
		DEVFLOW_USER_NAME: config.userName,
		DEVFLOW_ORGANIZATION_ID: config.organizationId,
		DEVFLOW_AUTH_PRIVATE_JWK_PATH: keys.userJwkPath,
		DEVFLOW_JWKS_URL: `http://127.0.0.1:${PORTS.api}/devflow/auth/jwks`,
		// Helper model calls (titles, next steps) run through Claude Code on the subscription.
		DEVFLOW_AI_PROVIDER: 'claude-code',
		DEVFLOW_HOME,
		// Default for projects that do not pick a sandbox: Docker containers (docker-sandbox.ts), the
		// shared Lima VM (`vm`, vm-sandbox.ts) or the host (`none`).
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
	// Sandboxed agents push branches and open PRs with gh; give them the host's gh login token. A host
	// that runs agents unsandboxed by default keeps the token out of its environment (set GH_TOKEN in
	// .env for its Docker or VM projects).
	if (env.DEVFLOW_AGENT_SANDBOX !== 'none' && !process.env.GH_TOKEN) {
		const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
		if (token.status === 0 && token.stdout.trim()) env.GH_TOKEN = token.stdout.trim()
	}
	if (!process.env.GITHUB_APP_ID) env.GITHUB_API_BASE_URL = OFFLINE_API_BASE_URL
	env.GITHUB_ACCOUNT_TOKEN_KEY = githubAccountTokenKey()
	return env
}

/**
 * The key the API encrypts stored GitHub account tokens with (Settings → GitHub accounts). Generated
 * once into the repository's .env, because a new key would leave every stored token unreadable.
 */
function githubAccountTokenKey(): string {
	return (
		process.env.GITHUB_ACCOUNT_TOKEN_KEY ||
		ensureEnvFileValue({
			path: join(REPO_ROOT, '.env'),
			key: 'GITHUB_ACCOUNT_TOKEN_KEY',
			comment: 'Encrypts stored GitHub account tokens. Generated by devflow; keep it, or re-add the accounts.',
			generate: () => randomBytes(32).toString('base64'),
		})
	)
}

/** `quiet` drops stdout and keeps the arguments out of the error, for commands that carry secrets. */
function run(
	command: string,
	args: string[],
	env: Record<string, string>,
	options: { cwd?: string; quiet?: boolean } = {},
): void {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? REPO_ROOT,
		env: { ...process.env, ...env },
		stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
	})
	if (result.error) throw result.error
	const shown = options.quiet ? `${command} ${args.slice(0, 2).join(' ')}` : `${command} ${args.join(' ')}`
	if (result.status !== 0) throw new Error(`${shown} exited with ${result.status}`)
}

function compose(env: Record<string, string>, args: string[]): void {
	run('docker', ['compose', '-f', join(REPO_ROOT, 'docker-compose.yaml'), ...args], env)
}

const CONTAINER_SERVICES = ['postgres', 'electric', 'minio', 'minio-setup', 'durable-streams', 'redis']

/**
 * Build the agent sandbox image (docker/devflow-agent) when it is missing. Any project can pick the
 * Docker sandbox whatever the host default, so this runs wherever a Docker daemon answers.
 */
function ensureAgentImage(): void {
	if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) return
	const present = spawnSync('docker', ['image', 'inspect', AGENT_IMAGE], { stdio: 'ignore' }).status === 0
	if (present) return
	console.log(`Building the agent sandbox image ${AGENT_IMAGE} (about 1 minute)...`)
	run('docker', ['build', '-t', AGENT_IMAGE, join(REPO_ROOT, 'docker/devflow-agent')], {})
}

/** Backend ports behind the app, api, sync and s3 routes. */
type RouteTargets = { ui: number; api: number; sync: number; s3: number }

const LOCAL_TARGETS: RouteTargets = { ui: PORTS.ui, api: PORTS.api, sync: PORTS.electricProxy, s3: PORTS.minioApi }

function writeCaddyfile(
	path = CADDYFILE_PATH,
	httpsPort = HTTPS_PORT,
	httpPort = HTTP_PORT,
	targets: RouteTargets = LOCAL_TARGETS,
): void {
	// Same route block as apps/launcher/src/lib/caddy.ts renderCaddyConfig, on one non-default port.
	const block = (url: string, port: number) =>
		`${url} {\n\treverse_proxy 127.0.0.1:${port} {\n\t\tflush_interval -1\n\t}\n\theader Cache-Control "no-cache, no-transform"\n\theader X-Accel-Buffering "no"\n}`
	const config = [
		`{\n\thttp_port ${httpPort}\n\thttps_port ${httpsPort}\n\tskip_install_trust\n\tlog {\n\t\tlevel WARN\n\t}\n}`,
		block(route('app', httpsPort), targets.ui),
		block(route('api', httpsPort), targets.api),
		block(route('sync', httpsPort), targets.sync),
		block(route('s3', httpsPort), targets.s3),
	].join('\n\n')
	writeFileSync(path, `# Generated by apps/launcher/src/devflow.ts. Do not edit.\n\n${config}\n`)
}

/** Written next to the UI build: the origins Vite baked in, so a port change forces a rebuild. */
const UI_BUILD_STAMP = join(REPO_ROOT, UI_DIR, 'dist/.devflow-build.json')

function uiBuildIsStale(): boolean {
	const builtIndex = join(REPO_ROOT, UI_DIR, 'dist/index.html')
	if (!existsSync(builtIndex)) return true
	if (!existsSync(UI_BUILD_STAMP) || readFileSync(UI_BUILD_STAMP, 'utf8') !== JSON.stringify(ROUTES)) return true
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
	ensureAgentImage()
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
	requireTool('docker')
	requireTool('caddy')
	requireTool('lsof')
	if (process.platform === 'linux') requireTool('certutil')
	const busy = [PORTS.ui, PORTS.api, PORTS.electricProxy, HTTPS_PORT].filter((port) => listeningPids(port).length > 0)
	if (busy.length > 0) {
		throw new Error(
			`Ports ${busy.join(', ')} are in use. Stop the process on them, or move devflow: bun run devflow up --port ${HTTPS_PORT + 1000}`,
		)
	}
	if (!existsSync(CONFIG_PATH)) await setup()
	const config = loadOrCreateConfig()
	const env = buildEnv(config)
	mkdirSync(LOG_DIR, { recursive: true })
	compose(env, ['up', '-d', '--wait', ...CONTAINER_SERVICES.filter((service) => service !== 'minio-setup')])
	writeCaddyfile()
	ensureAgentImage()
	// Bun's fetch trusts only its bundled CAs; the services call each other through Caddy's HTTPS routes.
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA }
	const devUi = process.argv.includes('--dev')
	if (!devUi && uiBuildIsStale()) {
		console.log('Building the UI (about 40s; skipped while sources are unchanged)...')
		run('bun', ['--bun', 'x', 'vite', 'build', '--logLevel', 'error'], env, { cwd: join(REPO_ROOT, UI_DIR) })
		writeFileSync(UI_BUILD_STAMP, JSON.stringify(ROUTES))
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
	start('caddy', 'caddy', ['run', '--config', CADDYFILE_PATH, '--adapter', 'caddyfile'], '.')
	// Caddy creates its root CA on first start, so trust it once the file appears.
	for (let waited = 0; !existsSync(CADDY_ROOT_CA) && waited < 15_000; waited += 250) {
		await new Promise((r) => setTimeout(r, 250))
	}
	trust()
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
	// `--name value` or `--name=value`.
	const joined = process.argv.find((arg) => arg.startsWith(`--${name}=`))
	if (joined) return joined.slice(name.length + 3)
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * An HTTPS port whose shifted stack (every base port, Redis and the HTTP port) stays within
 * 1024–65535, so no service lands on a privileged or out-of-range port.
 */
function parsePort(value: string | number): number {
	const port = Number(value)
	const offset = port - BASE_HTTPS_PORT
	const shifted = [...Object.values(BASE_PORTS), 47379, 47080, BASE_HTTPS_PORT].map((base) => base + offset)
	if (!Number.isInteger(port) || Math.min(...shifted) < 1024 || Math.max(...shifted) > 65535) {
		const low = BASE_HTTPS_PORT + 1024 - Math.min(...Object.values(BASE_PORTS), 47080)
		const high = BASE_HTTPS_PORT + 65535 - Math.max(...Object.values(BASE_PORTS), 47379)
		throw new Error(`Invalid port: ${value}. Pick ${low}–${high} so every service port stays in range.`)
	}
	return port
}

/**
 * What another machine's agent runner needs to act as a host of this server: the server's HTTPS port
 * (its URLs), the self-signed daemon credentials, the Caddy CA that signs those URLs (base64), and
 * the agent logins the sandbox uses when this machine has them.
 */
function hostEnvironment() {
	const config = loadOrCreateConfig()
	const keys = ensureKeys()
	if (!existsSync(CADDY_ROOT_CA))
		throw new Error(`No Caddy CA at ${CADDY_ROOT_CA}. Run bun run devflow up once first.`)
	const ghToken = process.env.GH_TOKEN ?? spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout?.trim()
	return {
		DEVFLOW_HTTPS_PORT: String(HTTPS_PORT),
		DEVFLOW_DAEMON_TOKEN_PRIVATE_KEY: keys.daemonPrivate,
		DEVFLOW_DAEMON_USER_ID: config.userId,
		DEVFLOW_DAEMON_ORGANIZATION_ID: config.organizationId,
		DEVFLOW_SERVER_CA: readFileSync(CADDY_ROOT_CA).toString('base64'),
		// Sandboxed agents push and open pull requests with it.
		GH_TOKEN: ghToken || undefined,
		CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
	}
}

/** Where `remote` puts the code on the other machine, relative to its home. */
const REMOTE_DIR = 'devflow-host'

/**
 * `remote <ssh-host>`: make another machine (e.g. a `cloud` VM) a host of this server. Copies the
 * working tree there, installs packages, writes ~/.devflow/host.env, then runs `devflow host` over
 * ssh with the remote's 127.0.0.1:<https port> forwarded back to this machine's Caddy, so it uses
 * the same URLs as the local agent runner. The host is listed while this runs; Ctrl-C stops the
 * remote agent runner too, and a dropped link reconnects.
 */
async function remote(): Promise<void> {
	requireTool('ssh')
	requireTool('lsof')
	const target = process.argv[3]
	if (!target || target.startsWith('-')) throw new Error('Usage: bun run devflow remote <ssh-host>')
	if (listeningPids(HTTPS_PORT).length === 0) {
		throw new Error(`Nothing listens on ${HTTPS_PORT}. Start the server first: bun run devflow up`)
	}
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
	// The remote user's interactive login shell, so PATH holds what an ssh login gets (e.g. mise tools).
	const inLoginShell = (command: string) => `exec "$SHELL" -lic ${quote(command)}`
	// A fresh connection each time: a shared ControlMaster session keeps the groups it logged in
	// with (e.g. predating `docker`), and the long-lived forward should not ride on it.
	const sshOptions = ['-o', 'ControlPath=none']
	const ssh = (command: string, input?: Buffer | string) => {
		const result = spawnSync('ssh', [...sshOptions, target, inLoginShell(command)], {
			input,
			stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
			maxBuffer: 1 << 30,
		})
		if (result.status !== 0) throw new Error(`ssh ${target} failed (${result.status}): ${command.slice(0, 40)}`)
	}

	console.log(`Copying the working tree to ${target}:~/${REMOTE_DIR}...`)
	// `git stash create` snapshots uncommitted tracked changes without touching the working tree.
	const stash = spawnSync('git', ['stash', 'create'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()
	const archive = spawnSync('git', ['archive', '--format=tar.gz', stash || 'HEAD'], {
		cwd: REPO_ROOT,
		maxBuffer: 1 << 30,
	})
	if (archive.status !== 0) throw new Error('git archive failed')
	// Extract completely before publishing files. Existing guests keep their plugin directory mount.
	ssh(
		`set -e
		mkdir -p ~/${REMOTE_DIR}/${REMOTE_STAGING}
		cd ~/${REMOTE_DIR}
		incoming=$(mktemp -d "$PWD/${REMOTE_STAGING}/archive.XXXXXXXX")
		trap 'rm -rf "$incoming"' EXIT
		tar -xzf - -C "$incoming"
		bun "$incoming/apps/launcher/src/lib/install-remote-tree.ts" "$incoming"`,
		archive.stdout,
	)
	// Pin Lima for NixOS runners missing it. Evaluate only the flake files: the archive has no .git
	// and evaluating its root would copy node_modules into the Nix store.
	const limaLink = '.devflow-lima'
	ssh(`set -e
		cd ~/${REMOTE_DIR}
		bun install --frozen-lockfile
		if [ -e /etc/NIXOS ] && [ -z "\${DEVFLOW_LIMACTL:-}" ] && ! command -v limactl >/dev/null; then
			mkdir -p .devflow-nix
			cp flake.nix flake.lock .devflow-nix/
			nix --extra-experimental-features 'nix-command flakes' build --inputs-from 'path:./.devflow-nix' 'nixpkgs#lima' --out-link ${limaLink}
		fi`)

	const lines = Object.entries(hostEnvironment()).flatMap(([name, value]) =>
		value === undefined ? [] : [`${name}=${quote(value)}`],
	)
	ssh('mkdir -p ~/.devflow && umask 077 && cat > ~/.devflow/host.env', `${lines.join('\n')}\n`)

	const forward = `127.0.0.1:${HTTPS_PORT}:127.0.0.1:${HTTPS_PORT}`
	// -tt gives the remote command a terminal, so it stops when this connection closes.
	const start = `cd ~/${REMOTE_DIR} && set -a && . ~/.devflow/host.env && set +a && if [ -d ${limaLink}/bin ]; then export PATH="$PWD/${limaLink}/bin:$PATH"; fi && exec bun run devflow host`
	let stopping = false
	let child: ReturnType<typeof spawn> | undefined
	const stop = () => {
		stopping = true
		child?.kill('SIGTERM')
	}
	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)
	console.log(`${target} is a host of ${ROUTES.ui} while this runs (Ctrl-C to stop).`)
	while (!stopping) {
		const code = await new Promise<number | null>((resolveExit) => {
			const session = spawn(
				'ssh',
				[
					...sshOptions,
					'-tt',
					'-o',
					'ExitOnForwardFailure=yes',
					'-o',
					'ServerAliveInterval=30',
					'-R',
					forward,
					target,
					inLoginShell(start),
				],
				{ stdio: ['ignore', 'inherit', 'inherit'] },
			)
			child = session
			session.once('exit', resolveExit)
		})
		if (stopping) break
		console.error(`[devflow] ${target} disconnected (${code}); reconnecting in 5s`)
		await new Promise((r) => setTimeout(r, 5000))
	}
}

/**
 * `host`: run only the agent runner, as a host of the server at DEVFLOW_HTTPS_PORT's URLs (reached
 * through the forward `remote` opens). `remote` starts this with ~/.devflow/host.env loaded.
 * Restarts the agent runner whenever it exits.
 */
async function host(): Promise<void> {
	requireTool('docker')
	const serverCa = process.env.DEVFLOW_SERVER_CA
	const missing = [
		'DEVFLOW_DAEMON_TOKEN_PRIVATE_KEY',
		'DEVFLOW_DAEMON_USER_ID',
		'DEVFLOW_DAEMON_ORGANIZATION_ID',
		'DEVFLOW_SERVER_CA',
	].filter((name) => !process.env[name])
	if (missing.length > 0)
		throw new Error(`Missing ${missing.join(', ')}. Start it from the server: bun run devflow remote <this host>`)
	mkdirSync(DEVFLOW_HOME, { recursive: true, mode: 0o700 })
	const caPath = join(DEVFLOW_HOME, 'server-ca.crt')
	writeFileSync(caPath, Buffer.from(serverCa ?? '', 'base64'))
	const env = {
		DEVSTACK_ID: STACK_ID,
		DEVFLOW_HOME,
		DEVFLOW_DAEMON_API_ORIGIN: ROUTES.api,
		DEVFLOW_DAEMON_SYNC_ORIGIN: ROUTES.sync,
		DEVFLOW_DAEMON_APP_ORIGIN: ROUTES.ui,
		DEVFLOW_DAEMON_LOAD_CREDS: 'true',
		DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: 'true',
		DEVFLOW_AGENT_SANDBOX: process.env.DEVFLOW_AGENT_SANDBOX ?? 'docker',
		DEVFLOW_AGENT_IMAGE: AGENT_IMAGE,
		NODE_EXTRA_CA_CERTS: caPath,
		LOG_BASE: LOG_DIR,
	}
	ensureAgentImage()
	let stopping = false
	let child: ReturnType<typeof spawn> | undefined
	const stop = () => {
		stopping = true
		child?.kill('SIGTERM')
	}
	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)
	console.log(`devflow host: agent runner for ${ROUTES.ui}`)
	while (!stopping) {
		const code = await new Promise<number | null>((resolveExit) => {
			const runner = spawn('bun', ['--bun', 'src/daemon.ts'], {
				cwd: join(REPO_ROOT, 'apps/agent-runner'),
				env: { ...process.env, ...env },
				stdio: 'inherit',
			})
			child = runner
			runner.once('exit', resolveExit)
		})
		if (stopping) break
		// Usually the server is unreachable (the forward from `remote` is down).
		console.error(`[devflow] agent runner exited (${code}); restarting in 5s`)
		await new Promise((r) => setTimeout(r, 5000))
	}
}

/**
 * Caddy's local CA root, which signs the *.devflow.localhost certificates. Caddy keeps it in its
 * data directory: $XDG_DATA_HOME/caddy when set, else the platform default (macOS: Application Support).
 */
function caddyDataDir(): string {
	if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'caddy')
	if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Caddy')
	return join(homedir(), '.local', 'share', 'caddy')
}
const CADDY_DATA_DIR = caddyDataDir()
const CADDY_ROOT_CA = join(CADDY_DATA_DIR, 'pki', 'authorities', 'local', 'root.crt')

const CA_NICKNAME = 'devflow local CA'

/** PEM body without armor or whitespace, to compare two encodings of one certificate. */
function pemBody(pem: string): string {
	return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
}

/**
 * `trust`: add Caddy's local CA to the NSS databases Chromium-family browsers (~/.pki/nssdb) and
 * Firefox profiles read on Linux. Caddy's own install (`skip_install_trust` is set) targets the
 * system store, which needs sudo and is read-only on NixOS. Re-runs replace a stale copy, e.g.
 * after Caddy's data directory was reset. Browsers that are open need a restart to pick it up.
 */
function trust(): void {
	if (process.platform !== 'linux') {
		console.log(`devflow trust: run \`caddy trust\` to trust ${CADDY_ROOT_CA} on this platform`)
		return
	}
	requireTool('certutil')
	if (!existsSync(CADDY_ROOT_CA))
		throw new Error(`${CADDY_ROOT_CA} does not exist yet. Start Caddy once: bun run devflow up`)
	const root = pemBody(readFileSync(CADDY_ROOT_CA, 'utf8'))
	const firefoxDir = join(homedir(), '.mozilla', 'firefox')
	const firefoxProfiles = existsSync(firefoxDir)
		? readdirSync(firefoxDir)
				.map((name) => join(firefoxDir, name))
				.filter((dir) => existsSync(join(dir, 'cert9.db')))
		: []
	const chromiumDb = join(homedir(), '.pki', 'nssdb')
	if (!existsSync(join(chromiumDb, 'cert9.db'))) {
		mkdirSync(chromiumDb, { recursive: true })
		spawnSync('certutil', ['-N', '-d', `sql:${chromiumDb}`, '--empty-password'])
	}
	for (const dir of [chromiumDb, ...firefoxProfiles]) {
		const db = `sql:${dir}`
		const current = spawnSync('certutil', ['-L', '-d', db, '-n', CA_NICKNAME, '-a'], { encoding: 'utf8' })
		if (current.status === 0 && pemBody(current.stdout) === root) continue
		// Drop every stale copy under the nickname before adding the current root.
		while (spawnSync('certutil', ['-D', '-d', db, '-n', CA_NICKNAME]).status === 0) {}
		const added = spawnSync('certutil', ['-A', '-d', db, '-n', CA_NICKNAME, '-t', 'C,,', '-i', CADDY_ROOT_CA], {
			encoding: 'utf8',
		})
		if (added.status !== 0) throw new Error(`certutil could not add the CA to ${dir}: ${added.stderr.trim()}`)
		console.log(`Trusted devflow's local CA in ${dir}; restart the browser if it is open.`)
	}
}

/**
 * `clean`: free disk under DEVFLOW_HOME (task worktrees, their node_modules, old logs, task VMs).
 * Reports what it would free; `--yes` does it. Rules in apps/launcher/src/lib/clean.ts.
 */
function clean(): void {
	const options = parseCleanArgs(process.argv.slice(3))
	// Reads the stack's existing config; clean never sets a stack up.
	if (!existsSync(join(DEVFLOW_HOME, 'config.json')))
		throw new Error(`No devflow stack in ${DEVFLOW_HOME}; nothing to clean.`)
	const env = buildEnv(loadOrCreateConfig())
	// The task states decide what may go, so without the database nothing is touched.
	const query = (sql: string) => {
		const result = spawnSync(
			'docker',
			[
				'compose',
				'-f',
				join(REPO_ROOT, 'docker-compose.yaml'),
				'exec',
				'-T',
				'postgres',
				'psql',
				'-U',
				'postgres',
				'electric',
				'-tAc',
				sql,
			],
			{ env: { ...process.env, ...env }, encoding: 'utf8' },
		)
		if (result.status !== 0) {
			const why = (result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`
			throw new Error(`Cannot read tasks from Postgres (is the stack up? bun run devflow up): ${why}`)
		}
		return result.stdout
	}
	console.log(options.useGh ? 'Checking worktrees (git fetch, gh pr list)...' : 'Checking worktrees (git fetch)...')
	const items = planClean({ devflowHome: DEVFLOW_HOME, options, query })
	const order = { remove: 0, deps: 1, keep: 2 } as const
	items.sort((a, b) => order[a.decision.action] - order[b.decision.action] || b.bytes - a.bytes)
	for (const item of items) {
		const size = item.decision.action === 'keep' ? '' : formatBytes(item.bytes)
		console.log(`${item.decision.action.padEnd(6)} ${size.padStart(8)}  ${item.label}  (${item.decision.reason})`)
	}
	const freeing = items.filter((item) => item.decision.action !== 'keep')
	if (!options.apply) {
		console.log(
			`\nWould free ${formatBytes(freeing.reduce((sum, item) => sum + item.bytes, 0))}. Run again with --yes to do it.`,
		)
		return
	}
	let freed = 0
	for (const item of freeing) {
		const failure = item.apply()
		if (failure) console.log(`not done: ${failure}`)
		else freed += item.bytes
	}
	console.log(`\nFreed ${formatBytes(freed)}.`)
}

const VM_USAGE = 'bun run devflow vm [ls | shell <name> | stop <name> | rm <name>]'

/** The limactl subcommand for a `devflow vm` action on one VM. */
function vmActionArgs(action: string): string[] | undefined {
	switch (action) {
		case 'shell':
			return ['shell']
		case 'stop':
			return ['stop']
		case 'rm':
			return ['delete', '--force']
		default:
			return undefined
	}
}

/**
 * `vm`: the Lima VMs agents of `vm` projects run in (apps/agent-runner/src/devflow/vm-sandbox.ts).
 * The daemon creates, stops and deletes them; this lists them and opens or removes one by hand.
 */
function vm(): void {
	requireTool('limactl')
	const [action = 'ls', name] = process.argv.slice(3)
	if (action === 'ls') {
		const listed = spawnSync('limactl', ['list'], { encoding: 'utf8' })
		if (listed.status !== 0) throw new Error(listed.stderr.trim())
		const [header = '', ...rows] = listed.stdout.trimEnd().split('\n')
		const ours = rows.filter((row) => row.startsWith('devflow-'))
		console.log(ours.length > 0 ? [header, ...ours].join('\n') : 'No devflow VMs.')
		return
	}
	const args = vmActionArgs(action)
	if (!args || !name?.startsWith('devflow-')) throw new Error(`Usage: ${VM_USAGE}`)
	const result = spawnSync('limactl', [...args, name], { stdio: 'inherit' })
	if (result.status !== 0) process.exit(result.status ?? 1)
}

/**
 * `setup-vm`: build the base VM every agent VM is cloned from (apps/agent-runner/src/devflow/setup-vm.ts):
 * a ~1 GB Ubuntu image download plus provisioning, once per VM template. Otherwise the first VM task
 * after `up` does it, and stopping `up` meanwhile throws the partial download away.
 */
function setupVm(): void {
	requireTool('limactl')
	// Two processes building the same base delete each other's unfinished instance.
	// The daemon refreshes its lock every 5 s; one untouched for 30 s is stale.
	const locks = join(homedir(), '.devflow', 'daemon-locks')
	const daemonRunning =
		existsSync(locks) &&
		readdirSync(locks).some((entry) => Date.now() - statSync(join(locks, entry)).mtimeMs < 30_000)
	if (daemonRunning) throw new Error('a devflow daemon is running; stop `bun run devflow up` first.')
	// A limactl left behind by a stopped daemon may still be building the base.
	const building = spawnSync('pgrep', ['-f', 'limactl.* (create|start) .*devflow-base-'], { encoding: 'utf8' })
	const pids = building.stdout.trim().split('\n').filter(Boolean)
	if (pids.length > 0)
		throw new Error(
			`limactl is already building a base VM (pid ${pids.join(', ')}); wait for it to exit or kill it.`,
		)
	run('bun', ['--bun', 'src/devflow/setup-vm.ts'], { DEVFLOW_HOME }, { cwd: join(REPO_ROOT, 'apps/agent-runner') })
}

/** `e2e`: Playwright tests in apps/e2e against the running stack (installed Chrome). */
function e2e(): void {
	const result = spawnSync('bun', ['x', 'playwright', 'test', ...process.argv.slice(3)], {
		cwd: join(REPO_ROOT, 'apps/e2e'),
		// The tests call the API with fetch, which only trusts the local CA when told about it.
		env: {
			...process.env,
			DEVFLOW_HOME,
			NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA,
			DEVFLOW_APP_URL: ROUTES.ui,
			DEVFLOW_API_URL: ROUTES.api,
			DEVFLOW_API_PORT: String(PORTS.api),
		},
		stdio: 'inherit',
	})
	process.exit(result.status ?? 1)
}

/** Arguments for cargo: everything but the launcher's own `--port N` / `--port=N`, which picks the
 * stack. After cargo's `--`, everything goes to the app as given. */
function cargoArgs(args: string[]): string[] {
	const out: string[] = []
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? ''
		if (arg === '--') return [...out, ...args.slice(index)]
		if (arg === '--port') index += 1
		else if (!arg.startsWith('--port=')) out.push(arg)
	}
	return out
}

/**
 * `desktop`: the native client in apps/desktop (macOS only) against the running stack. Needs the
 * Rust toolchain from `nix develop`; further arguments go to cargo, e.g. `--release`.
 */
function desktop(): void {
	// The client embeds WKWebView through AppKit; nix only provides its toolchain on macOS.
	if (process.platform !== 'darwin') {
		console.error('devflow desktop runs on macOS only')
		process.exit(1)
	}
	requireTool('cargo')
	const result = spawnSync('cargo', ['run', '-p', 'devflow-desktop', ...cargoArgs(process.argv.slice(3))], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			DEVFLOW_HOME,
			DEVFLOW_APP_ORIGIN: ROUTES.ui,
			DEVFLOW_API_ORIGIN: ROUTES.api,
			DEVFLOW_SYNC_ORIGIN: ROUTES.sync,
		},
		stdio: 'inherit',
	})
	process.exit(result.status ?? 1)
}

const commands: Record<string, () => void | Promise<void>> = {
	desktop,
	e2e,
	setup,
	'setup-vm': setupVm,
	trust,
	up,
	down,
	status,
	env: printEnv,
	host,
	remote,
	vm,
	clean,
}
/**
 * Every other command goes to devflow's CLI (apps/cli) against this stack, e.g.
 * `bun run devflow api tasks list`, `bun run devflow api sync sessions --task-id <id>`.
 */
function forwardToCli(args: string[]): void {
	const env = buildEnv(loadOrCreateConfig())
	const result = spawnSync('bun', ['--bun', 'src/index.ts', '--local', ...args], {
		cwd: join(REPO_ROOT, 'apps/cli'),
		env: { ...process.env, ...env, NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA },
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
