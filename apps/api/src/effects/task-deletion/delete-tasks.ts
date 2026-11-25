import { artifacts } from '@devflow/db/tables/artifacts'
import { sessions } from '@devflow/db/tables/sessions'
import { taskLaunches } from '@devflow/db/tables/task-launches'
import { tasks } from '@devflow/db/tables/tasks'
import { and, eq, inArray, or } from 'drizzle-orm'
import { Effect } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import { DurableStreamsConfig } from '../services/durable-streams/durable-streams-config.service'
import type { PostgresTransaction } from '../services/postgres/postgres-db.service'
import { TaskDiffService } from '../services/task-diff-durable-streams/task-diff-durable-streams.service'

export interface DeletedTasks {
	/** The sessions that went with the tasks, whose conversation streams the caller removes after commit. */
	readonly sessionIds: readonly string[]
}

/**
 * Hard-delete a set of tasks inside the caller's transaction. Every delete path (one task, a project,
 * archived tasks in bulk) funnels through here, after it has locked and checked what it may delete.
 *
 * The FK graph can't do this alone:
 * - `sessions.task_id` is SET NULL, so a bare task delete would leave the sessions behind as
 *   standalone rows. They are deleted explicitly, and their children cascade (approvals,
 *   conversation_events, queued_messages, session_repositories, session_usage_events,
 *   pull_request_sessions).
 * - `task_launches.first_session_id` has no ON DELETE action, so the launch rows go before the
 *   sessions they point at.
 * - `artifacts.task_id` has no FK at all. Deleting the artifacts cascades their versions, comments
 *   and operation log in the same statement.
 * - The task delete then cascades the ACLs, task_user_settings, task_workspace_setup_for_host,
 *   artifact_comments and diff_comments. `pull_requests` and `commits` are SET NULL, so a pushed PR
 *   keeps its row, no longer linked to a task.
 *
 * Nothing on hosts or GitHub is touched.
 */
export const deleteTasksInTransaction = (
	transaction: PostgresTransaction,
	input: { readonly organizationId: string; readonly taskIds: readonly string[] },
) =>
	Effect.gen(function* () {
		if (input.taskIds.length === 0) return { sessionIds: [] } satisfies DeletedTasks
		const taskIds = [...input.taskIds]
		const sessionRows = yield* transaction.query(
			transaction.client
				.select({ id: sessions.id })
				.from(sessions)
				.where(and(eq(sessions.organization_id, input.organizationId), inArray(sessions.task_id, taskIds))),
		)
		const sessionIds = sessionRows.map((row) => row.id)

		yield* transaction.query(
			transaction.client
				.delete(artifacts)
				.where(and(eq(artifacts.organization_id, input.organizationId), inArray(artifacts.task_id, taskIds))),
		)
		yield* transaction.query(
			transaction.client
				.delete(taskLaunches)
				.where(
					sessionIds.length > 0
						? or(inArray(taskLaunches.task_id, taskIds), inArray(taskLaunches.first_session_id, sessionIds))
						: inArray(taskLaunches.task_id, taskIds),
				),
		)
		if (sessionIds.length > 0) {
			yield* transaction.query(
				transaction.client
					.delete(sessions)
					.where(and(eq(sessions.organization_id, input.organizationId), inArray(sessions.id, sessionIds))),
			)
		}
		yield* transaction.query(
			transaction.client
				.delete(tasks)
				.where(and(eq(tasks.organization_id, input.organizationId), inArray(tasks.id, taskIds))),
		)
		return { sessionIds } satisfies DeletedTasks
	}).pipe(Effect.withSpan('task_deletion.delete_tasks', { attributes: { task_count: input.taskIds.length } }))

const deleteSessionStream = (client: HttpClient.HttpClient, url: string, sessionId: string) =>
	client.execute(HttpClientRequest.delete(url)).pipe(
		Effect.flatMap((response) =>
			response.status === 404 ? Effect.void : HttpClientResponse.filterStatusOk(response).pipe(Effect.asVoid),
		),
		Effect.tapError((error) =>
			Effect.logWarning('Session stream deletion failed', error).pipe(
				Effect.annotateLogs({ session_id: sessionId }),
			),
		),
		Effect.ignore,
	)

/**
 * Best-effort removal of the durable streams deleted tasks leave behind: each session's conversation
 * stream and each task's diff streams. Runs after commit; a failure is logged and never undoes the
 * delete.
 */
export const deleteTaskStreams = (input: {
	readonly organizationId: string
	readonly taskIds: readonly string[]
	readonly sessionIds: readonly string[]
}) =>
	Effect.gen(function* () {
		const config = yield* DurableStreamsConfig
		const client = yield* HttpClient.HttpClient
		const taskDiff = yield* TaskDiffService
		yield* Effect.all(
			[
				...input.sessionIds.map((sessionId) =>
					deleteSessionStream(client, config.streamUrl(sessionId), sessionId),
				),
				...input.taskIds.map((taskId) =>
					taskDiff.deleteTaskDiffStreams({ organizationId: input.organizationId, taskId }),
				),
			],
			{ concurrency: 4, discard: true },
		)
	}).pipe(
		Effect.withSpan('task_deletion.delete_streams', {
			attributes: {
				organization_id: input.organizationId,
				task_count: input.taskIds.length,
				session_count: input.sessionIds.length,
			},
		}),
	)
