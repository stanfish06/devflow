import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { projectUserSettings } from '@devflow/db/tables/project-user-settings'
import { projects } from '@devflow/db/tables/projects'
import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { and, eq, sql } from 'drizzle-orm'
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
				.select({ id: githubAccounts.id })
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
	if (accountId !== null) yield* lockOwnGithubAccount(transaction, actor, accountId)
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
})

/**
 * Choose the account the actor's agents act as in one task they can read. Per person: it changes
 * only the actor's own row, so a teammate's sessions on the task keep their own choice.
 */
export const setTaskGithubAccount = Effect.fn('github_accounts.set_task_account')(function* (input: {
	readonly actor: GithubAccountActor
	readonly taskId: string
	readonly accountId: string | null
}) {
	const postgres = yield* PostgresDb
	const { actor } = input
	yield* postgres.transaction((transaction) =>
		Effect.gen(function* () {
			const task = yield* requireTaskReadPermission(transaction, { ...actor, taskId: input.taskId })
			yield* writeTaskGithubAccountChoice(transaction, {
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
