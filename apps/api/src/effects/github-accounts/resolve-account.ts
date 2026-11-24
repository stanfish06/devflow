import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { projectUserSettings } from '@devflow/db/tables/project-user-settings'
import { sessions } from '@devflow/db/tables/sessions'
import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { tasks } from '@devflow/db/tables/tasks'
import { userSettings } from '@devflow/db/tables/user-settings'
import { workspaces } from '@devflow/db/tables/workspaces'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Data, Effect, type Redacted } from 'effect'

import { PostgresDb } from '../services/postgres/postgres-db.service'
import { tokenCipherContext, type GithubAccountActor } from './github-accounts'
import { TokenCipher } from './token-cipher'

/** The daemon asking: a registration of one user's host in one organization. */
export interface GithubAccountDaemon extends GithubAccountActor {
	readonly hostId: string
}

/**
 * The session doesn't exist, or wasn't created by this daemon's user on this host (the two are
 * indistinguishable on purpose).
 */
export class GithubSessionNotFound extends Data.TaggedError('GithubSessionNotFound')<{
	readonly sessionId: string
}> {}

/**
 * Which identity a session's agent uses: an account with its decrypted token, or the host's own gh
 * login when none is chosen (today's behaviour).
 */
export type GithubAccountResolution = Data.TaggedEnum<{
	Account: {
		readonly accountId: string
		readonly login: string
		readonly name: string | null
		readonly email: string
		readonly token: Redacted.Redacted<string>
	}
	HostLogin: {}
}>

export const GithubAccountResolution = Data.taggedEnum<GithubAccountResolution>()

/**
 * Which GitHub account a session's agent acts as. Resolution runs through the session creator's own
 * choices only, so it is always one of their accounts. The first level with a choice wins:
 *
 *   the task (task_user_settings: an account, or the host's own gh login)
 *   → the task's project (project_user_settings)
 *   → your default (user_settings.default_github_account_id; null is the host's own gh login)
 *   → the host's own gh login
 *
 * A removed account is no choice at all (its references are set null), so resolution falls through
 * to the next level. An account whose token GitHub has since rejected is still returned: the run
 * must fail as that account, never fall back to another one.
 */
export const resolveGithubAccountForSession = Effect.fn('github_accounts.resolve_for_session')(function* (input: {
	readonly daemon: GithubAccountDaemon
	readonly sessionId: string
}) {
	const postgres = yield* PostgresDb
	const cipher = yield* TokenCipher
	const { daemon, sessionId } = input

	// Strictly the daemon's own sessions: its organization, its user as creator, its host.
	const [session] = yield* postgres.query(
		postgres.client
			.select({ taskId: sessions.task_id })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.organization_id, daemon.organizationId),
					eq(sessions.created_by, daemon.userId),
					eq(sessions.host_id, daemon.hostId),
				),
			),
	)
	if (session === undefined) return yield* Effect.fail(new GithubSessionNotFound({ sessionId }))

	const actor: GithubAccountActor = { organizationId: daemon.organizationId, userId: daemon.userId }
	const choices = yield* githubAccountChoices(actor, session.taskId)
	if (choices === 'host') return GithubAccountResolution.HostLogin()

	const candidates = yield* postgres.query(
		postgres.client
			.select({
				id: githubAccounts.id,
				login: githubAccounts.login,
				name: githubAccounts.name,
				noreplyEmail: githubAccounts.noreply_email,
				tokenIv: githubAccounts.token_iv,
				tokenCiphertext: githubAccounts.token_ciphertext,
			})
			.from(githubAccounts)
			.where(
				and(
					inArray(githubAccounts.id, choices),
					// Every choice can only ever be one of the user's own accounts; never trust that alone.
					eq(githubAccounts.organization_id, actor.organizationId),
					eq(githubAccounts.user_id, actor.userId),
				),
			),
	)
	const account = choices
		.map((accountId) => candidates.find((candidate) => candidate.id === accountId))
		.find((candidate) => candidate !== undefined)
	if (account === undefined) return GithubAccountResolution.HostLogin()

	const token = yield* cipher.decrypt(
		{ iv: account.tokenIv, ciphertext: account.tokenCiphertext },
		tokenCipherContext(actor),
	)
	return GithubAccountResolution.Account({
		accountId: account.id,
		login: account.login,
		name: account.name,
		email: account.noreplyEmail,
		token,
	})
})

/**
 * The accounts the user chose for a task, most specific first (task, project, default), or `'host'`
 * when the first level with a choice picks the host's own gh login. A session without a task has
 * only the user's default.
 */
const githubAccountChoices = Effect.fn('github_accounts.account_choices')(function* (
	actor: GithubAccountActor,
	taskId: string | null,
) {
	const postgres = yield* PostgresDb
	const choices: string[] = []

	if (taskId !== null) {
		// A workspace's project is authoritative over the task's own project_id, as in the sidebar.
		const projectId = sql`coalesce(${workspaces.project_id}, ${tasks.project_id})`
		const [task] = yield* postgres.query(
			postgres.client
				.select({
					taskAccountId: taskUserSettings.github_account_id,
					taskUsesHostLogin: taskUserSettings.github_use_host_login,
					projectAccountId: projectUserSettings.github_account_id,
				})
				.from(tasks)
				.leftJoin(
					workspaces,
					and(eq(workspaces.id, tasks.workspace_id), eq(workspaces.organization_id, tasks.organization_id)),
				)
				.leftJoin(
					taskUserSettings,
					and(
						eq(taskUserSettings.task_id, tasks.id),
						eq(taskUserSettings.organization_id, actor.organizationId),
						eq(taskUserSettings.user_id, actor.userId),
					),
				)
				.leftJoin(
					projectUserSettings,
					and(
						eq(projectUserSettings.organization_id, actor.organizationId),
						eq(projectUserSettings.user_id, actor.userId),
						eq(projectUserSettings.project_id, projectId),
					),
				)
				.where(and(eq(tasks.id, taskId), eq(tasks.organization_id, actor.organizationId))),
		)
		if (task?.taskUsesHostLogin) return 'host' as const
		if (task?.taskAccountId) choices.push(task.taskAccountId)
		if (task?.projectAccountId) choices.push(task.projectAccountId)
	}

	const [settings] = yield* postgres.query(
		postgres.client
			.select({ defaultAccountId: userSettings.default_github_account_id })
			.from(userSettings)
			.where(and(eq(userSettings.organization_id, actor.organizationId), eq(userSettings.user_id, actor.userId))),
	)
	if (settings?.defaultAccountId) choices.push(settings.defaultAccountId)
	return choices.length > 0 ? choices : ('host' as const)
})
