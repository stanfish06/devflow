import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { projectUserSettings } from '@devflow/db/tables/project-user-settings'
import { projects } from '@devflow/db/tables/projects'
import { DAEMON_ACTIVE_SESSION_STATUSES, sessions } from '@devflow/db/tables/sessions'
import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Data, Effect } from 'effect'

import { projectReadableByActor } from '../project-workspace/project-authorization'
import { requireTaskReadPermission } from '../services/postgres/helpers'
import { PostgresDb, type PostgresTransaction } from '../services/postgres/postgres-db.service'
import { GithubAccountNotFound } from './errors'
import type { GithubAccountActor } from './github-accounts'

/** The project doesn't exist, or the caller can't read it (the two are indistinguishable on purpose). */
export class GithubProjectNotFound extends Data.TaggedError('GithubProjectNotFound')<{
	readonly projectId: string
}> {}

const nowMillis = sql`(extract(epoch from now()) * 1000)::bigint`

/**
 * Check an account is the actor's own, and share-lock it for the rest of the transaction so a
 * concurrent remove can't leave the choice pointing at nothing. The FK alone would accept anyone's.
 */
function lockOwnGithubAccount(transaction: PostgresTransaction, actor: GithubAccountActor, accountId: string) {
	return Effect.gen(function* () {
		const [account] = yield* transaction.query(
			transaction.client
				.select({ id: githubAccounts.id, login: githubAccounts.login })
				.from(githubAccounts)
				.where(
					and(
						eq(githubAccounts.id, accountId),
						eq(githubAccounts.organization_id, actor.organizationId),
						eq(githubAccounts.user_id, actor.userId),
					),
				)
				.for('share'),
		)
		if (account === undefined) return yield* Effect.fail(new GithubAccountNotFound({ accountId }))
		return account
	})
}

/** The auto-advance switches a new settings row starts with, so it doesn't change what the user sees. */
type TaskUserSettingsSeed = Pick<
	typeof taskUserSettings.$inferInsert,
	| 'auto_advance_questions_to_research'
	| 'auto_advance_research_to_design'
	| 'auto_advance_plan_to_worktree'
	| 'auto_advance_worktree_to_implementation'
	| 'auto_advance_implementation_to_pr'
>

/**
 * Record the actor's pick for one task, inside the caller's transaction: one of their accounts, or
 * null for each host's own gh login. Only explicit picks are written; a task without one keeps
 * following the project's default and the actor's own.
 */
export const writeTaskGithubAccountChoice = Effect.fn('github_accounts.write_task_choice')(function* (
	transaction: PostgresTransaction,
	input: {
		readonly actor: GithubAccountActor
		readonly taskId: string
		readonly accountId: string | null
		readonly seed?: TaskUserSettingsSeed
	},
) {
	const { actor, accountId } = input
	const account = accountId === null ? null : yield* lockOwnGithubAccount(transaction, actor, accountId)
	const choice = { github_account_id: accountId, github_use_host_login: accountId === null }
	yield* transaction.query(
		transaction.client
			.insert(taskUserSettings)
			.values({
				task_id: input.taskId,
				user_id: actor.userId,
				organization_id: actor.organizationId,
				...input.seed,
				...choice,
			})
			.onConflictDoUpdate({
				target: [taskUserSettings.organization_id, taskUserSettings.user_id, taskUserSettings.task_id],
				set: { ...choice, updated_at: nowMillis },
			}),
	)
	/** The picked account's login, or null for the host's own gh login. */
	return { login: account?.login ?? null }
})

/**
 * The `content` of the system event that records a switch in a session's conversation. The web app
 * shows it as "Account changed to {login}" (null: the host's own gh login).
 */
export function githubAccountChangedNotice(login: string | null): string {
	return JSON.stringify({ kind: 'github_account_changed', login })
}

/** The actor's pick for one task as stored, locked until the transaction ends; undefined when no row. */
function lockTaskGithubAccountChoice(transaction: PostgresTransaction, actor: GithubAccountActor, taskId: string) {
	return Effect.gen(function* () {
		const [row] = yield* transaction.query(
			transaction.client
				.select({
					accountId: taskUserSettings.github_account_id,
					useHostLogin: taskUserSettings.github_use_host_login,
				})
				.from(taskUserSettings)
				.where(
					and(
						eq(taskUserSettings.organization_id, actor.organizationId),
						eq(taskUserSettings.user_id, actor.userId),
						eq(taskUserSettings.task_id, taskId),
					),
				)
				.for('update'),
		)
		return row
	})
}

/**
 * Record a switch in each of the actor's live sessions on the task: the ones a daemon is running
 * right now, whose agent picks the new account up from its next commit, push or PR. Teammates'
 * sessions resolve through their own choices, so they are left alone.
 */
function appendGithubAccountChangedNotices(
	transaction: PostgresTransaction,
	input: { readonly actor: GithubAccountActor; readonly taskId: string; readonly login: string | null },
) {
	return Effect.gen(function* () {
		const { actor, taskId } = input
		const live = yield* transaction.query(
			transaction.client
				.select({ id: sessions.id, resourceOwnerUserId: sessions.resource_owner_user_id })
				.from(sessions)
				.where(
					and(
						eq(sessions.organization_id, actor.organizationId),
						eq(sessions.task_id, taskId),
						eq(sessions.created_by, actor.userId),
						eq(sessions.archived, false),
						inArray(sessions.status, [...DAEMON_ACTIVE_SESSION_STATUSES]),
					),
				),
		)
		if (live.length === 0) return
		const content = githubAccountChangedNotice(input.login)
		yield* transaction.query(
			transaction.client.insert(conversationEvents).values(
				live.map((session) => ({
					session_id: session.id,
					organization_id: actor.organizationId,
					resource_owner_user_id: session.resourceOwnerUserId,
					task_id: taskId,
					event_type: 'system' as const,
					role: 'system' as const,
					content,
					user_id: actor.userId,
				})),
			),
		)
	})
}

/**
 * Choose the account the actor's agents act as in one task they can read. Per person: it changes
 * only the actor's own row, so a teammate's sessions on the task keep their own choice. A change
 * (not a re-pick of the same choice) is recorded in the actor's live sessions on the task.
 */
export const setTaskGithubAccount = Effect.fn('github_accounts.set_task_account')(function* (input: {
	readonly actor: GithubAccountActor
	readonly taskId: string
	readonly accountId: string | null
}) {
	const postgres = yield* PostgresDb
	const { actor, accountId } = input
	yield* postgres.transaction((transaction) =>
		Effect.gen(function* () {
			const task = yield* requireTaskReadPermission(transaction, { ...actor, taskId: input.taskId })
			const previous = yield* lockTaskGithubAccountChoice(transaction, actor, input.taskId)
			const unchanged =
				previous !== undefined &&
				previous.accountId === accountId &&
				previous.useHostLogin === (accountId === null)
			const { login } = yield* writeTaskGithubAccountChoice(transaction, {
				actor,
				taskId: input.taskId,
				accountId: input.accountId,
				// A teammate reads auto-advance from their own row once it exists; start it at the task's.
				seed: {
					auto_advance_questions_to_research: task.auto_advance_questions_to_research,
					auto_advance_research_to_design: task.auto_advance_research_to_design,
					auto_advance_plan_to_worktree: task.auto_advance_plan_to_worktree,
					auto_advance_worktree_to_implementation: task.auto_advance_worktree_to_implementation,
					auto_advance_implementation_to_pr: task.auto_advance_implementation_to_pr,
				},
			})
			if (!unchanged)
				yield* appendGithubAccountChangedNotices(transaction, { actor, taskId: input.taskId, login })
		}),
	)
	return {}
})

/**
 * Choose the account the actor's agents act as in a project's tasks, or null for no project default
 * (their own default applies). Any reader of the project may pick, since the choice is their own.
 */
export const setProjectGithubAccount = Effect.fn('github_accounts.set_project_account')(function* (input: {
	readonly actor: GithubAccountActor
	readonly projectId: string
	readonly accountId: string | null
}) {
	const postgres = yield* PostgresDb
	const { actor, accountId, projectId } = input
	yield* postgres.transaction((transaction) =>
		Effect.gen(function* () {
			const [project] = yield* transaction.query(
				transaction.client
					.select({ id: projects.id })
					.from(projects)
					.where(and(projectReadableByActor(actor), eq(projects.id, projectId)))
					.for('share'),
			)
			if (project === undefined) return yield* Effect.fail(new GithubProjectNotFound({ projectId }))
			if (accountId !== null) yield* lockOwnGithubAccount(transaction, actor, accountId)
			yield* transaction.query(
				transaction.client
					.insert(projectUserSettings)
					.values({
						organization_id: actor.organizationId,
						user_id: actor.userId,
						project_id: projectId,
						github_account_id: accountId,
					})
					.onConflictDoUpdate({
						target: [
							projectUserSettings.organization_id,
							projectUserSettings.user_id,
							projectUserSettings.project_id,
						],
						set: { github_account_id: accountId, updated_at: nowMillis },
					}),
			)
		}),
	)
	return {}
})
