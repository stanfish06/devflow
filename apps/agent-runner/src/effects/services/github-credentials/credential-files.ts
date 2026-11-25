/**
 * Pure pieces of a session's GitHub credential directory: where its files live, what they say, and
 * how the agent's environment points at them. No IO here; github-credentials.layer.ts writes them.
 *
 *   <run>/<sessionId>/github/          0700
 *   ├── gh/hosts.yml                    0600  gh's login: github.com as the account, with its token
 *   ├── gh/config.yml                   0600  marks the config as current, so gh never migrates it
 *   ├── token                           0600  read by the git credential helper on every request
 *   └── gitconfig                       0600  the agent's global git config (GIT_CONFIG_GLOBAL)
 *
 * `git` and `gh` re-read these on every invocation, so rewriting them changes the identity from the
 * agent's next commit, push or PR without restarting it.
 */
import { join } from 'node:path'

import { Redacted } from 'effect'

/** The account a session's agent acts as. The token stays Redacted until it is written to disk. */
export interface GithubAccountCredentials {
	readonly login: string
	/** GitHub display name; the login stands in when the profile has none. */
	readonly name: string | null
	/** The account's `@users.noreply.github.com` address. */
	readonly email: string
	readonly token: Redacted.Redacted<string>
}

/** The two variables that point `gh` and `git` at a session's credential directory. */
export interface GithubEnv {
	readonly GH_CONFIG_DIR: string
	readonly GIT_CONFIG_GLOBAL: string
}

/**
 * Variables that would override the credential directory, so they never reach an agent that acts as
 * an account: an env token beats gh's stored login, and `GIT_AUTHOR_*` / `GIT_COMMITTER_*` beat the
 * gitconfig's `[user]`.
 */
export const GITHUB_ENV_OVERRIDES = /^(GH_TOKEN|GITHUB_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*)$/

export interface CredentialPaths {
	/** `<run>/<sessionId>`: removed whole when the session ends. */
	readonly sessionDirectory: string
	/** `<run>/<sessionId>/github`: the directory a sandboxed agent gets mounted. */
	readonly directory: string
	readonly ghConfigDirectory: string
	readonly ghHostsFile: string
	readonly ghConfigFile: string
	readonly tokenFile: string
	readonly gitconfigFile: string
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Session ids become directory names, so only a UUID is accepted: nothing that could leave `run`. */
export function isCredentialSessionId(sessionId: string): boolean {
	return SESSION_ID.test(sessionId)
}

export function credentialPaths(runDirectory: string, sessionId: string): CredentialPaths {
	if (!isCredentialSessionId(sessionId)) throw new Error('A credential directory needs a session UUID')
	const sessionDirectory = join(runDirectory, sessionId)
	const directory = join(sessionDirectory, 'github')
	const ghConfigDirectory = join(directory, 'gh')
	return {
		sessionDirectory,
		directory,
		ghConfigDirectory,
		ghHostsFile: join(ghConfigDirectory, 'hosts.yml'),
		ghConfigFile: join(ghConfigDirectory, 'config.yml'),
		tokenFile: join(directory, 'token'),
		gitconfigFile: join(directory, 'gitconfig'),
	}
}

export function githubEnvFor(paths: CredentialPaths): GithubEnv {
	return { GH_CONFIG_DIR: paths.ghConfigDirectory, GIT_CONFIG_GLOBAL: paths.gitconfigFile }
}

/**
 * The agent's environment with the credential directory in charge: the overrides above removed and
 * the two pointers set. With no account (`null`), the environment is returned untouched, so the
 * host's own gh login and git identity apply exactly as before.
 */
export function withGithubEnvironment<V extends string | undefined>(
	env: Readonly<Record<string, V>>,
	githubEnv: GithubEnv | null,
): Record<string, V | string> {
	if (githubEnv === null) return { ...env }
	const result: Record<string, V | string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (!GITHUB_ENV_OVERRIDES.test(key)) result[key] = value
	}
	return { ...result, ...githubEnv }
}

/** Printable characters with no whitespace: every GitHub token and login fits. */
const TOKEN_LIKE = /^[\x21-\x7e]+$/
/** No control characters: names and paths are written into line-oriented config files. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/** Why an account can't be written safely, or null when it can. Never mentions the token's value. */
export function credentialProblem(account: GithubAccountCredentials): string | null {
	if (!TOKEN_LIKE.test(Redacted.value(account.token))) return 'the token has unexpected characters'
	if (!TOKEN_LIKE.test(account.login)) return 'the login has unexpected characters'
	if (!TOKEN_LIKE.test(account.email)) return 'the email has unexpected characters'
	if (account.name !== null && CONTROL_CHARACTER.test(account.name)) return 'the name has unexpected characters'
	return null
}

/** A YAML double-quoted scalar. JSON string syntax is valid YAML, escapes included. */
const yamlString = (value: string) => JSON.stringify(value)

/** gh's multi-account `hosts.yml` (gh 2.40+), logged in to github.com as the account only. */
export function renderGhHostsYml(account: GithubAccountCredentials): string {
	const login = yamlString(account.login)
	const token = yamlString(Redacted.value(account.token))
	return [
		'github.com:',
		'    git_protocol: https',
		'    users:',
		`        ${login}:`,
		`            oauth_token: ${token}`,
		`    oauth_token: ${token}`,
		`    user: ${login}`,
		'',
	].join('\n')
}

/**
 * gh's `config.yml`. `version: "1"` marks it as already in the multi-account layout, so gh never
 * tries to migrate the hosts file (which can move tokens into the system keyring).
 */
export function renderGhConfigYml(): string {
	return ['version: "1"', 'git_protocol: https', 'prompt: disabled', ''].join('\n')
}

/** The token file the credential helper reads: just the token. */
export function renderTokenFile(account: GithubAccountCredentials): string {
	return `${Redacted.value(account.token)}\n`
}

/** A git config value in double quotes, with git's escapes for `\` and `"`. */
function gitConfigString(value: string): string {
	if (CONTROL_CHARACTER.test(value)) throw new Error('A git config value cannot hold control characters')
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** A word in POSIX single quotes. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The credential helper: answers `get` with the account's login and the token read from its file,
 * and ignores `store` / `erase`. Reading the file on each request (rather than embedding the token)
 * keeps the token out of `git config --list`, whose output an agent could post to its conversation.
 */
export function credentialHelper(account: Pick<GithubAccountCredentials, 'login'>, tokenFile: string): string {
	return [
		'!f() {',
		'test "$1" = get || exit 0;',
		'cat >/dev/null;',
		`echo ${shellQuote(`username=${account.login}`)};`,
		`echo "password=$(cat ${shellQuote(tokenFile)})";`,
		'}; f',
	].join(' ')
}

/**
 * The agent's global git config.
 *
 * - `includePaths` brings in the host user's own global config first (non-sandboxed runs), so their
 *   settings still apply; everything after it wins. Sandboxed runs pass none: the container never
 *   sees the host's config.
 * - `[user]` makes the account the author and committer of every commit.
 * - `[url]` sends SSH GitHub remotes over HTTPS, so pushes go through the helper rather than the
 *   host's SSH key.
 * - `[credential]` first clears every helper configured before it (the user's keychain, the sandbox
 *   image's `gh auth git-credential`), then answers with the account's token.
 */
export function renderGitconfig(input: {
	readonly account: GithubAccountCredentials
	readonly tokenFile: string
	readonly includePaths: readonly string[]
}): string {
	const { account } = input
	const lines = ['# Written by devflow for one agent session, and removed when it ends.']
	if (input.includePaths.length > 0) {
		lines.push('[include]', ...input.includePaths.map((path) => `\tpath = ${gitConfigString(path)}`))
	}
	lines.push(
		'[user]',
		`\tname = ${gitConfigString(account.name?.trim() || account.login)}`,
		`\temail = ${gitConfigString(account.email)}`,
		'[url "https://github.com/"]',
		`\tinsteadOf = ${gitConfigString('git@github.com:')}`,
		`\tinsteadOf = ${gitConfigString('ssh://git@github.com/')}`,
		'[credential "https://github.com"]',
		`\thelper = ""`,
		`\thelper = ${gitConfigString(credentialHelper(account, input.tokenFile))}`,
		'',
	)
	return lines.join('\n')
}

/**
 * A credential helper that answers every request with `quit`, so git stops at once: it asks no
 * other helper and never prompts. GitHub access fails instead of going out as anyone.
 */
export const LOCKED_CREDENTIAL_HELPER = '!f() { cat >/dev/null; echo quit=1; }; f'

/**
 * The directory's contents when it can no longer act as any account, while an agent that started
 * with it is still running: its environment points `gh` and `git` here and can't be changed until
 * the agent restarts, so this is what they read until then.
 *
 * - gh has no login (and the env token it would otherwise fall back to was never passed).
 * - git has no `[user]` (on the host it inherits the user's own identity through `includePaths`),
 *   SSH GitHub remotes still go over HTTPS, and every credential request is refused.
 */
export function renderLockedGitconfig(input: { readonly includePaths: readonly string[] }): string {
	const lines = [
		'# Written by devflow for one agent session, and removed when it ends.',
		"# This session's GitHub account changed; GitHub access stays closed until its agent restarts.",
	]
	if (input.includePaths.length > 0) {
		lines.push('[include]', ...input.includePaths.map((path) => `\tpath = ${gitConfigString(path)}`))
	}
	lines.push(
		'[url "https://github.com/"]',
		`\tinsteadOf = ${gitConfigString('git@github.com:')}`,
		`\tinsteadOf = ${gitConfigString('ssh://git@github.com/')}`,
		'[credential "https://github.com"]',
		`\thelper = ""`,
		`\thelper = ${gitConfigString(LOCKED_CREDENTIAL_HELPER)}`,
		'',
	)
	return lines.join('\n')
}

/** gh's `hosts.yml` with no login at all: an empty document. */
export function renderLockedGhHostsYml(): string {
	return "# This session's GitHub account changed; gh stays logged out until its agent restarts.\n"
}

/**
 * The host user's own global git config files, in the order git reads them, for a non-sandboxed
 * agent to include. `GIT_CONFIG_GLOBAL` in the daemon's environment replaces both defaults.
 */
export function hostGlobalGitConfigPaths(env: {
	readonly HOME?: string | undefined
	readonly XDG_CONFIG_HOME?: string | undefined
	readonly GIT_CONFIG_GLOBAL?: string | undefined
}): string[] {
	if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL]
	const paths: string[] = []
	const xdg = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : undefined)
	if (xdg) paths.push(join(xdg, 'git', 'config'))
	if (env.HOME) paths.push(join(env.HOME, '.gitconfig'))
	return paths.filter((path) => !CONTROL_CHARACTER.test(path))
}
