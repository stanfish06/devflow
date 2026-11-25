import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { artifactVersions } from '@devflow/db/tables/artifact-versions'
import { artifacts } from '@devflow/db/tables/artifacts'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { organizations } from '@devflow/db/tables/organizations'
import { pullRequests } from '@devflow/db/tables/pull-requests'
import { sessions } from '@devflow/db/tables/sessions'
import { taskLaunches } from '@devflow/db/tables/task-launches'
import { taskUserAcl } from '@devflow/db/tables/task-user-acl'
import { tasks } from '@devflow/db/tables/tasks'
import { DurableStream } from '@durable-streams/client'
import { DurableStreamTestServer } from '@durable-streams/server'
import { call } from '@orpc/server'
import { eq, inArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AppRuntime } from '../../src/effects/app-runtime'
import { deleteTaskEffectProcedure } from '../../src/orpc/api/tasks/delete.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('tasks.delete', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let server: DurableStreamTestServer
	let runtime: AppRuntime
	let procedure: typeof deleteTaskEffectProcedure
	let organizationId: string
	let otherOrganizationId: string
	const ownerId = 'task-delete-owner'
	const teammateId = 'task-delete-teammate'

	beforeAll(async () => {
		const testDb = await createTestDb('tasks_delete')
		db = testDb.db
		cleanup = testDb.cleanup
		server = new DurableStreamTestServer({ port: 0, host: '127.0.0.1' })
		await server.start()
		runtime = createRuntimeWithTestPostgresLayer(db, { durableStreamsOrigin: server.url })
		procedure = bindProcedureToRuntime(deleteTaskEffectProcedure, runtime)
		const [owner, other] = await db
			.insert(organizations)
			.values([
				{ name: 'Delete tasks', workos_organization_id: `org_${randomUUID()}` },
				{ name: 'Other delete tasks', workos_organization_id: `org_${randomUUID()}` },
			])
			.returning()
		if (!owner || !other) throw new Error('Could not seed organizations')
		organizationId = owner.id
		otherOrganizationId = other.id
	}, 60_000)

	afterAll(async () => {
		try {
			await runtime?.dispose()
			await server?.stop()
		} finally {
			await cleanup?.()
		}
	}, 30_000)

	const asUser = (userId: string, orgId = organizationId) => ({
		context: createMockApiContext({
			auth: createMockApiAuth({ organizationId: orgId, userId }),
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		}),
	})

	let pullRequestNumber = 0
	/** A task with everything a delete has to reach: sessions, events, artifacts, a launch and a PR. */
	const seedTask = async (input: { owner?: string; orgId?: string } = {}) => {
		const owner = input.owner ?? ownerId
		const orgId = input.orgId ?? organizationId
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: orgId,
				name: 'Task to delete',
				resource_owner_user_id: owner,
				created_by: owner,
				default_working_directory: tmpdir(),
			})
			.returning({ id: tasks.id })
		if (!task) throw new Error('Could not seed task')
		const sessionRows = await db
			.insert(sessions)
			.values(
				[owner, teammateId].map((createdBy, index) => ({
					organization_id: orgId,
					resource_owner_user_id: owner,
					created_by: createdBy,
					host_id: `host-${index}`,
					title: `Session ${index}`,
					working_directory: tmpdir(),
					coding_agent: 'claude' as const,
					provider: 'anthropic' as const,
					model: 'claude-sonnet-4-5',
					permissions_mode: 'default' as const,
					status: index === 0 ? ('running' as const) : ('ready_for_input' as const),
					task_id: task.id,
				})),
			)
			.returning({ id: sessions.id })
		const sessionIds = sessionRows.map((row) => row.id)
		const [firstSessionId] = sessionIds
		if (!firstSessionId) throw new Error('Could not seed sessions')
		await db.insert(taskLaunches).values({
			task_id: task.id,
			first_session_id: firstSessionId,
			launch_transaction_id: randomUUID(),
		})
		const now = BigInt(Date.now())
		await db.insert(conversationEvents).values(
			sessionIds.map((sessionId) => ({
				session_id: sessionId,
				task_id: task.id,
				organization_id: orgId,
				resource_owner_user_id: owner,
				event_type: 'message' as const,
				role: 'user' as const,
				content: 'Hello',
				created_at: now,
				updated_at: now,
			})),
		)
		const [artifact] = await db
			.insert(artifacts)
			.values({
				task_id: task.id,
				file_name: `notes-${randomUUID()}.md`,
				content: 'notes',
				content_hash: 'hash-notes',
				resource_owner_user_id: owner,
				organization_id: orgId,
				created_by: owner,
			})
			.returning({ id: artifacts.id })
		if (!artifact) throw new Error('Could not seed artifact')
		await db.insert(artifactVersions).values({
			artifact_id: artifact.id,
			task_id: task.id,
			organization_id: orgId,
			resource_owner_user_id: owner,
			content: 'notes',
			content_hash: 'hash-notes',
			created_by: owner,
			version_number: 1,
		})
		await db.insert(taskUserAcl).values({
			task_id: task.id,
			subject_user_id: teammateId,
			organization_id: orgId,
			resource_owner_user_id: owner,
			permission_level: 'edit',
			granted_by: owner,
		})
		const [pullRequest] = await db
			.insert(pullRequests)
			.values({
				organization_id: orgId,
				task_id: task.id,
				session_id: firstSessionId,
				resource_owner_user_id: owner,
				repo_full_name: 'acme/delete',
				number: (pullRequestNumber += 1),
				url: 'https://github.com/acme/delete/pull/1',
				title: 'Pushed before the delete',
				state: 'open',
				head_ref: 'feature-delete',
				source: 'daemon',
			})
			.returning({ id: pullRequests.id })
		if (!pullRequest) throw new Error('Could not seed pull request')
		return { taskId: task.id, sessionIds, artifactId: artifact.id, pullRequestId: pullRequest.id }
	}

	const rowsFor = async (seeded: Awaited<ReturnType<typeof seedTask>>) => ({
		tasks: await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, seeded.taskId)),
		sessions: await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, seeded.sessionIds)),
		events: await db
			.select({ id: conversationEvents.id })
			.from(conversationEvents)
			.where(inArray(conversationEvents.session_id, seeded.sessionIds)),
		artifacts: await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.task_id, seeded.taskId)),
		versions: await db
			.select({ id: artifactVersions.id })
			.from(artifactVersions)
			.where(eq(artifactVersions.artifact_id, seeded.artifactId)),
		launches: await db
			.select({ id: taskLaunches.task_id })
			.from(taskLaunches)
			.where(eq(taskLaunches.task_id, seeded.taskId)),
		acls: await db.select({ id: taskUserAcl.id }).from(taskUserAcl).where(eq(taskUserAcl.task_id, seeded.taskId)),
	})

	const counts = async (seeded: Awaited<ReturnType<typeof seedTask>>) =>
		Object.fromEntries(Object.entries(await rowsFor(seeded)).map(([table, rows]) => [table, rows.length]))

	it('deletes the task with its sessions, events, artifacts, launch and ACLs, and keeps the PR unlinked', async () => {
		const seeded = await seedTask()
		const bystander = await seedTask()

		await expect(call(procedure, { taskId: seeded.taskId }, asUser(ownerId))).resolves.toEqual({
			taskId: seeded.taskId,
		})

		expect(await counts(seeded)).toEqual({
			tasks: 0,
			sessions: 0,
			events: 0,
			artifacts: 0,
			versions: 0,
			launches: 0,
			acls: 0,
		})
		const [pullRequest] = await db.select().from(pullRequests).where(eq(pullRequests.id, seeded.pullRequestId))
		expect(pullRequest).toMatchObject({ task_id: null, session_id: null, title: 'Pushed before the delete' })
		expect(await counts(bystander)).toEqual({
			tasks: 1,
			sessions: 2,
			events: 2,
			artifacts: 1,
			versions: 1,
			launches: 1,
			acls: 1,
		})
	})

	it('refuses a teammate, even one with edit access, and deletes nothing', async () => {
		const seeded = await seedTask()
		await expect(call(procedure, { taskId: seeded.taskId }, asUser(teammateId))).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		expect((await counts(seeded)).tasks).toBe(1)
		expect((await counts(seeded)).sessions).toBe(2)
	})

	it('reports a missing task, and a task in another organization, as not found', async () => {
		await expect(
			call(procedure, { taskId: '01960000-0000-7000-8000-000000000000' }, asUser(ownerId)),
		).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		const elsewhere = await seedTask({ orgId: otherOrganizationId })
		await expect(call(procedure, { taskId: elsewhere.taskId }, asUser(ownerId))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		expect((await counts(elsewhere)).tasks).toBe(1)
	})

	it('deletes the conversation and task-diff streams after the commit', async () => {
		const seeded = await seedTask()
		const taskBase = `${server.url}/v1/stream/organizations/${organizationId}/tasks/${seeded.taskId}`
		const urls = [
			...seeded.sessionIds.map((sessionId) => `${server.url}/v1/stream/sessions/${sessionId}`),
			`${taskBase}/diff-files`,
			`${taskBase}/diff-patches`,
			`${taskBase}/diff-file-versions`,
		]
		await Promise.all(urls.map((url) => DurableStream.create({ url, contentType: 'application/json' })))
		const anyExists = async () =>
			(await Promise.all(urls.map((url) => DurableStream.head({ url })))).some((head) => head.exists)
		expect(await anyExists()).toBe(true)

		await call(procedure, { taskId: seeded.taskId }, asUser(ownerId))
		expect((await counts(seeded)).tasks).toBe(0)

		for (let attempt = 0; attempt < 100 && (await anyExists()); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		expect(await anyExists()).toBe(false)
	})

	it('still deletes the rows when the stream server is unreachable', async () => {
		const unreachable = createRuntimeWithTestPostgresLayer(db, { durableStreamsOrigin: 'http://127.0.0.1:9' })
		try {
			const seeded = await seedTask()
			await expect(
				call(
					bindProcedureToRuntime(deleteTaskEffectProcedure, unreachable),
					{ taskId: seeded.taskId },
					{
						context: createMockApiContext({
							auth: createMockApiAuth({ organizationId, userId: ownerId }),
							services: { db, dbReadReplica: db, effectRuntime: unreachable },
						}),
					},
				),
			).resolves.toEqual({ taskId: seeded.taskId })
			expect((await counts(seeded)).tasks).toBe(0)
		} finally {
			await unreachable.dispose()
		}
	})
})
