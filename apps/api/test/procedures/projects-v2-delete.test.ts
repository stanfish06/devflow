import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { organizations } from '@devflow/db/tables/organizations'
import { projects } from '@devflow/db/tables/projects'
import { repositoryLocationsForUserForHost } from '@devflow/db/tables/repository-locations-for-user-for-host'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { userSettings } from '@devflow/db/tables/user-settings'
import { workspaceLocationsForUserForHost } from '@devflow/db/tables/workspace-locations-for-user-for-host'
import { workspaces } from '@devflow/db/tables/workspaces'
import { describe, it } from '@effect/vitest'
import { call } from '@orpc/server'
import { eq, inArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { afterAll, beforeAll, expect } from 'vitest'

import { deleteProject } from '../../src/effects/project-workspace/project-operations'
import { DurableStreamsConfig } from '../../src/effects/services/durable-streams/durable-streams-config.service'
import {
	makeEffectPostgresDbService,
	PostgresDb,
	PostgresDbLive,
} from '../../src/effects/services/postgres/postgres-db.service'
import { TaskDiffServiceLive } from '../../src/effects/services/task-diff-durable-streams/task-diff-durable-streams.service'
import { projectDeletePreviewV2Procedure } from '../../src/orpc/api/projects-v2/delete-preview.effect'
import { deleteProjectV2Procedure } from '../../src/orpc/api/projects-v2/delete.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const repository = {
	remoteUrl: 'git@github.com:devflow/delete-me.git',
	repositoryIdentity: 'github.com/devflow/delete-me',
	defaultBranch: 'main',
	default: true,
	autoPushBranch: false,
	copyGlobs: [],
}

/** Stream cleanup runs after commit against a server that isn't there; it fails fast and is ignored. */
const STREAMS_ORIGIN = 'http://127.0.0.1:9'

/** What `deleteProject` needs beyond Postgres, for tests that run it directly. */
const streamCleanup = Layer.mergeAll(
	Layer.succeed(DurableStreamsConfig, {
		origin: STREAMS_ORIGIN,
		contentType: 'application/json',
		ttlSeconds: 600,
		streamUrl: (sessionId: string) => `${STREAMS_ORIGIN}/v1/stream/sessions/${sessionId}`,
	}),
	TaskDiffServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				FetchHttpClient.layer,
				ConfigProvider.layer(ConfigProvider.fromUnknown({ DURABLE_STREAMS_ORIGIN: STREAMS_ORIGIN })),
			),
		),
		Layer.orDie,
	),
	FetchHttpClient.layer,
)

describe('projects.v2.delete', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let preview: typeof projectDeletePreviewV2Procedure
	let remove: typeof deleteProjectV2Procedure
	let organizationId: string
	const ownerId = 'project-delete-owner'
	const teammateId = 'project-delete-teammate'

	beforeAll(async () => {
		const testDb = await createTestDb('projects_v2_delete')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db, { durableStreamsOrigin: STREAMS_ORIGIN })
		preview = bindProcedureToRuntime(projectDeletePreviewV2Procedure, runtime)
		remove = bindProcedureToRuntime(deleteProjectV2Procedure, runtime)
		const [organization] = await db
			.insert(organizations)
			.values({ name: 'Delete projects', workos_organization_id: `org_${randomUUID()}` })
			.returning()
		if (!organization) throw new Error('Could not seed organization')
		organizationId = organization.id
		await db.insert(userSettings).values(
			[ownerId, teammateId].map((userId) => ({
				organization_id: organizationId,
				user_id: userId,
				projects_v2_enabled: true,
			})),
		)
	}, 60_000)

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			await cleanup?.()
		}
	}, 30_000)

	const asUser = (userId: string) => ({
		context: createMockApiContext({
			auth: createMockApiAuth({ organizationId, userId }),
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		}),
	})

	const insertTask = (values: { owner: string; projectId?: string; workspaceId?: string; archived?: boolean }) =>
		db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				name: 'Task in a project',
				resource_owner_user_id: values.owner,
				created_by: values.owner,
				default_working_directory: tmpdir(),
				project_id: values.projectId ?? null,
				workspace_id: values.workspaceId ?? null,
				archived: values.archived ?? false,
			})
			.returning({ id: tasks.id })
			.then(([task]) => {
				if (!task) throw new Error('Could not seed task')
				return task.id
			})

	/**
	 * A project owned by `ownerId` holding four tasks: the owner's, an archived one of the owner's,
	 * a teammate's with no ACL (private, so the owner never syncs it), and one that reaches the
	 * project only through its workspace. Each task has a session.
	 */
	const seedProject = async () => {
		const [project] = await db
			.insert(projects)
			.values({
				organization_id: organizationId,
				name: `Project ${randomUUID()}`,
				created_by: ownerId,
				resource_owner_user_id: ownerId,
				repositories: [repository],
			})
			.returning({ id: projects.id })
		if (!project) throw new Error('Could not seed project')
		const [workspace] = await db
			.insert(workspaces)
			.values({
				organization_id: organizationId,
				project_id: project.id,
				name: 'Workspace',
				created_by: ownerId,
				resource_owner_user_id: ownerId,
				repositories: [{ ...repository, branch: 'task-branch' }],
			})
			.returning({ id: workspaces.id })
		if (!workspace) throw new Error('Could not seed workspace')
		const taskIds = [
			await insertTask({ owner: ownerId, projectId: project.id }),
			await insertTask({ owner: ownerId, projectId: project.id, archived: true }),
			await insertTask({ owner: teammateId, projectId: project.id }),
			await insertTask({ owner: ownerId, workspaceId: workspace.id }),
		]
		const sessionRows = await db
			.insert(sessions)
			.values(
				taskIds.map((taskId, index) => ({
					organization_id: organizationId,
					resource_owner_user_id: index === 2 ? teammateId : ownerId,
					created_by: index === 2 ? teammateId : ownerId,
					host_id: 'host-a',
					working_directory: tmpdir(),
					status: 'ready_for_input' as const,
					task_id: taskId,
				})),
			)
			.returning({ id: sessions.id })
		await db.insert(workspaceLocationsForUserForHost).values({
			organization_id: organizationId,
			project_id: project.id,
			workspace_id: workspace.id,
			user_id: ownerId,
			host_id: 'host-a',
			file_path: '/tmp/workspaces/delete-me',
		})
		return {
			projectId: project.id,
			workspaceId: workspace.id,
			taskIds,
			sessionIds: sessionRows.map((row) => row.id),
		}
	}

	type Seeded = Awaited<ReturnType<typeof seedProject>>

	const counts = async (seeded: Seeded) => ({
		projects: (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, seeded.projectId))).length,
		workspaces: (
			await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.project_id, seeded.projectId))
		).length,
		workspaceLocations: (
			await db
				.select({ id: workspaceLocationsForUserForHost.workspace_id })
				.from(workspaceLocationsForUserForHost)
				.where(eq(workspaceLocationsForUserForHost.project_id, seeded.projectId))
		).length,
		tasks: (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, seeded.taskIds))).length,
		sessions: (await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, seeded.sessionIds)))
			.length,
	})

	const untouched = { projects: 1, workspaces: 1, workspaceLocations: 1, tasks: 4, sessions: 4 }

	it('counts every task the delete would take, teammates’ private and archived ones included', async () => {
		const seeded = await seedProject()
		await expect(call(preview, { projectId: seeded.projectId }, asUser(ownerId))).resolves.toEqual({
			taskCount: 4,
			otherPeoplesTaskCount: 1,
		})
	})

	it('deletes the project with all its tasks, sessions and workspaces, and keeps the checkouts', async () => {
		const seeded = await seedProject()
		const bystander = await seedProject()
		await db.insert(repositoryLocationsForUserForHost).values({
			organization_id: organizationId,
			user_id: ownerId,
			host_id: 'host-a',
			repository_identity: repository.repositoryIdentity,
			source_kind: 'filesystem',
			source_path: '/srv/delete-me',
		})

		await expect(
			call(remove, { projectId: seeded.projectId, expectedTaskCount: 4 }, asUser(ownerId)),
		).resolves.toEqual({ deletedTaskCount: 4 })

		expect(await counts(seeded)).toEqual({
			projects: 0,
			workspaces: 0,
			workspaceLocations: 0,
			tasks: 0,
			sessions: 0,
		})
		expect(await counts(bystander)).toEqual(untouched)
		// The checkout on the host is keyed by repository, and other projects may share it.
		const checkouts = await db
			.select()
			.from(repositoryLocationsForUserForHost)
			.where(eq(repositoryLocationsForUserForHost.organization_id, organizationId))
		expect(checkouts).toHaveLength(1)
	})

	it('refuses a count that no longer matches, and deletes nothing', async () => {
		const seeded = await seedProject()
		await expect(
			call(remove, { projectId: seeded.projectId, expectedTaskCount: 3 }, asUser(ownerId)),
		).rejects.toMatchObject({ code: 'COUNT_CHANGED', data: { expected: 3, actual: 4 } })
		expect(await counts(seeded)).toEqual(untouched)
	})

	it('refuses anyone but the owner, even a teammate with tasks in the project', async () => {
		const seeded = await seedProject()
		await expect(call(preview, { projectId: seeded.projectId }, asUser(teammateId))).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		await expect(
			call(remove, { projectId: seeded.projectId, expectedTaskCount: 4 }, asUser(teammateId)),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(await counts(seeded)).toEqual(untouched)
	})

	it('reports a missing project as not found', async () => {
		const projectId = randomUUID()
		await expect(call(preview, { projectId }, asUser(ownerId))).rejects.toMatchObject({ code: 'NOT_FOUND' })
		await expect(call(remove, { projectId, expectedTaskCount: 0 }, asUser(ownerId))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})

	it.effect('a task inserted while the delete waits on the project lock makes the count change', () =>
		Effect.gen(function* () {
			const seeded = yield* Effect.promise(() => seedProject())
			const inserted = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
			const deletionStarted = yield* Deferred.make<void>()
			const postgres = yield* PostgresDb
			// A real transaction models a teammate starting a task in the project: its FK check holds a
			// key-share lock on the project row until it commits.
			const inserting = yield* postgres
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx.query(
							tx.client.insert(tasks).values({
								organization_id: organizationId,
								name: 'Started while confirming',
								resource_owner_user_id: teammateId,
								created_by: teammateId,
								default_working_directory: tmpdir(),
								project_id: seeded.projectId,
							}),
						)
						yield* Deferred.succeed(inserted, undefined)
						yield* Deferred.await(release)
					}),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(inserted)
			// NOWAIT proves the insert's lock blocks the delete's FOR UPDATE, without polling or sleeps.
			expect(
				yield* postgres
					.query(
						db
							.select()
							.from(projects)
							.where(eq(projects.id, seeded.projectId))
							.for('update', { noWait: true }),
					)
					.pipe(Effect.flip),
			).toMatchObject({ code: '55P03' })
			const deleting = yield* Deferred.succeed(deletionStarted, undefined).pipe(
				Effect.andThen(
					deleteProject({
						actor: { organizationId, userId: ownerId },
						projectId: seeded.projectId,
						expectedTaskCount: 4,
					}),
				),
				Effect.flip,
				Effect.forkChild,
			)
			yield* Deferred.await(deletionStarted)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(inserting)
			expect(yield* Fiber.join(deleting)).toMatchObject({ _tag: 'CountChanged', expected: 4, actual: 5 })
			expect(yield* Effect.promise(() => counts(seeded))).toEqual(untouched)
			// Confirming the new count goes through.
			expect(
				yield* deleteProject({
					actor: { organizationId, userId: ownerId },
					projectId: seeded.projectId,
					expectedTaskCount: 5,
				}),
			).toEqual({ deletedTaskCount: 5 })
		}).pipe(Effect.provide(Layer.mergeAll(PostgresDbLive(db), streamCleanup))),
	)

	it.effect('a task started while the delete holds the lock waits for it, then fails', () =>
		Effect.gen(function* () {
			const seeded = yield* Effect.promise(() => seedProject())
			const deleted = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
			const insertStarted = yield* Deferred.make<void>()
			const live = makeEffectPostgresDbService(db)
			// Delegate every SQL operation to real Postgres; pause only after the deletion program,
			// while its transaction still holds the project lock and has not committed.
			const heldTransaction = Layer.succeed(PostgresDb, {
				...live,
				transaction: (program) =>
					live.transaction((tx) =>
						program(tx).pipe(
							Effect.tap(() => Deferred.succeed(deleted, undefined)),
							Effect.tap(() => Deferred.await(release)),
						),
					),
			})
			const deleting = yield* deleteProject({
				actor: { organizationId, userId: ownerId },
				projectId: seeded.projectId,
				expectedTaskCount: 4,
			}).pipe(Effect.provide(Layer.mergeAll(heldTransaction, streamCleanup)), Effect.forkChild)
			yield* Deferred.await(deleted)
			const starting = yield* Deferred.succeed(insertStarted, undefined).pipe(
				Effect.andThen(
					Effect.promise(() =>
						insertTask({ owner: teammateId, projectId: seeded.projectId }).then(
							() => 'unexpected success',
							(failure: unknown) => failure,
						),
					),
				),
				Effect.forkChild,
			)
			yield* Deferred.await(insertStarted)
			yield* Deferred.succeed(release, undefined)
			expect(yield* Fiber.join(deleting)).toEqual({ deletedTaskCount: 4 })
			// The FK check waited on the lock and found the project gone.
			expect(yield* Fiber.join(starting)).toMatchObject({ cause: { code: '23503' } })
			expect(yield* Effect.promise(() => counts(seeded))).toEqual({
				projects: 0,
				workspaces: 0,
				workspaceLocations: 0,
				tasks: 0,
				sessions: 0,
			})
		}),
	)
})
