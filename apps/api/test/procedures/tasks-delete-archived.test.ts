import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { organizations } from '@devflow/db/tables/organizations'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { describe, it } from '@effect/vitest'
import { call } from '@orpc/server'
import { eq, inArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { afterAll, beforeAll, expect } from 'vitest'

import { DurableStreamsConfig } from '../../src/effects/services/durable-streams/durable-streams-config.service'
import { PostgresDb, PostgresDbLive } from '../../src/effects/services/postgres/postgres-db.service'
import { TaskDiffServiceLive } from '../../src/effects/services/task-diff-durable-streams/task-diff-durable-streams.service'
import { deleteArchived } from '../../src/effects/task-deletion/delete-archived-tasks'
import { deleteArchivedTasksPreviewProcedure } from '../../src/orpc/api/tasks/delete-archived-preview.effect'
import { deleteArchivedTasksProcedure } from '../../src/orpc/api/tasks/delete-archived.effect'
import { createMockApiAuth, createMockApiContext } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/** Stream cleanup runs after commit against a server that isn't there; it fails fast and is ignored. */
const STREAMS_ORIGIN = 'http://127.0.0.1:9'

/** What `deleteArchived` needs beyond Postgres, for tests that run it directly. */
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

describe('tasks.deleteArchived', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let preview: typeof deleteArchivedTasksPreviewProcedure
	let remove: typeof deleteArchivedTasksProcedure
	let organizationId: string
	let otherOrganizationId: string

	beforeAll(async () => {
		const testDb = await createTestDb('tasks_delete_archived')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db, { durableStreamsOrigin: STREAMS_ORIGIN })
		preview = bindProcedureToRuntime(deleteArchivedTasksPreviewProcedure, runtime)
		remove = bindProcedureToRuntime(deleteArchivedTasksProcedure, runtime)
		const [organization, other] = await db
			.insert(organizations)
			.values([
				{ name: 'Delete archived tasks', workos_organization_id: `org_${randomUUID()}` },
				{ name: 'Other delete archived tasks', workos_organization_id: `org_${randomUUID()}` },
			])
			.returning()
		if (!organization || !other) throw new Error('Could not seed organizations')
		organizationId = organization.id
		otherOrganizationId = other.id
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

	/** A task owned by `owner`, with a session started by each of `sessionsBy`. */
	const insertTask = async (values: {
		owner: string
		archived: boolean
		isDraft?: boolean
		orgId?: string
		sessionsBy?: readonly string[]
	}) => {
		const orgId = values.orgId ?? organizationId
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: orgId,
				name: 'Task',
				resource_owner_user_id: values.owner,
				created_by: values.owner,
				default_working_directory: tmpdir(),
				archived: values.archived,
				is_draft: values.isDraft ?? false,
			})
			.returning({ id: tasks.id })
		if (!task) throw new Error('Could not seed task')
		const sessionRows =
			(values.sessionsBy ?? []).length === 0
				? []
				: await db
						.insert(sessions)
						.values(
							(values.sessionsBy ?? []).map((createdBy) => ({
								organization_id: orgId,
								resource_owner_user_id: values.owner,
								created_by: createdBy,
								host_id: 'host-a',
								working_directory: tmpdir(),
								status: 'ready_for_input' as const,
								archived: values.archived,
								task_id: task.id,
							})),
						)
						.returning({ id: sessions.id })
		return { taskId: task.id, sessionIds: sessionRows.map((row) => row.id) }
	}

	/**
	 * Archived and open tasks around one user, each test with its own: two archived tasks of theirs
	 * (one a draft), one open task of theirs, a teammate's archived task they ran a session in (shared),
	 * a teammate's archived task they never touched, and their own archived task in another organization.
	 */
	const seedArchive = async () => {
		const me = `archive-owner-${randomUUID()}`
		const teammate = `archive-teammate-${randomUUID()}`
		const own = [
			await insertTask({ owner: me, archived: true, sessionsBy: [me, teammate] }),
			await insertTask({ owner: me, archived: true, isDraft: true }),
		]
		const kept = [
			await insertTask({ owner: me, archived: false, sessionsBy: [me] }),
			await insertTask({ owner: teammate, archived: true, sessionsBy: [teammate, me] }),
			await insertTask({ owner: teammate, archived: true, sessionsBy: [teammate] }),
			await insertTask({ owner: me, archived: true, orgId: otherOrganizationId, sessionsBy: [me] }),
		]
		return { me, teammate, own, kept }
	}

	type Seeded = Awaited<ReturnType<typeof seedArchive>>

	const remaining = async (group: Seeded['own'] | Seeded['kept']) => ({
		tasks: (
			await db
				.select({ id: tasks.id })
				.from(tasks)
				.where(
					inArray(
						tasks.id,
						group.map((task) => task.taskId),
					),
				)
		).length,
		sessions: (
			await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(
					inArray(
						sessions.id,
						group.flatMap((task) => task.sessionIds),
					),
				)
		).length,
	})

	it('counts only your own archived tasks, and the shared archived tasks it skips', async () => {
		const seeded = await seedArchive()
		await expect(call(preview, {}, asUser(seeded.me))).resolves.toEqual({
			deletableCount: 2,
			skippedSharedCount: 1,
		})
		// The teammate owns two archived tasks of their own and ran a session in one of the user's.
		await expect(call(preview, {}, asUser(seeded.teammate))).resolves.toEqual({
			deletableCount: 2,
			skippedSharedCount: 1,
		})
	})

	it('deletes your archived tasks with their sessions, and skips shared, open and other organizations’ tasks', async () => {
		const seeded = await seedArchive()
		await expect(call(remove, { expectedCount: 2 }, asUser(seeded.me))).resolves.toEqual({ deletedCount: 2 })

		expect(await remaining(seeded.own)).toEqual({ tasks: 0, sessions: 0 })
		expect(await remaining(seeded.kept)).toEqual({ tasks: 4, sessions: 5 })
		await expect(call(preview, {}, asUser(seeded.me))).resolves.toEqual({
			deletableCount: 0,
			skippedSharedCount: 1,
		})
	})

	it('refuses a count that no longer matches, and deletes nothing', async () => {
		const seeded = await seedArchive()
		await expect(call(remove, { expectedCount: 1 }, asUser(seeded.me))).rejects.toMatchObject({
			code: 'COUNT_CHANGED',
			data: { expected: 1, actual: 2 },
		})
		expect(await remaining(seeded.own)).toEqual({ tasks: 2, sessions: 2 })
		expect(await remaining(seeded.kept)).toEqual({ tasks: 4, sessions: 5 })
	})

	it('deletes nothing, and succeeds, when there is nothing archived of yours', async () => {
		const loner = `archive-empty-${randomUUID()}`
		const open = await insertTask({ owner: loner, archived: false, sessionsBy: [loner] })
		await expect(call(preview, {}, asUser(loner))).resolves.toEqual({ deletableCount: 0, skippedSharedCount: 0 })
		await expect(call(remove, { expectedCount: 0 }, asUser(loner))).resolves.toEqual({ deletedCount: 0 })
		expect(await remaining([open])).toEqual({ tasks: 1, sessions: 1 })
	})

	it.effect('a task unarchived while the delete waits on its lock drops out and makes the count change', () =>
		Effect.gen(function* () {
			const seeded = yield* Effect.promise(() => seedArchive())
			const [unarchivedTask] = seeded.own
			if (!unarchivedTask) throw new Error('Seed has no archived task')
			const updated = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
			const deletionStarted = yield* Deferred.make<void>()
			const postgres = yield* PostgresDb
			// A real transaction models unarchiving from another tab: it holds the task's row lock until
			// it commits.
			const unarchiving = yield* postgres
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx.query(
							tx.client.update(tasks).set({ archived: false }).where(eq(tasks.id, unarchivedTask.taskId)),
						)
						yield* Deferred.succeed(updated, undefined)
						yield* Deferred.await(release)
					}),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(updated)
			// NOWAIT proves the update's lock blocks the delete's FOR UPDATE, without polling or sleeps.
			expect(
				yield* postgres
					.query(
						db
							.select()
							.from(tasks)
							.where(eq(tasks.id, unarchivedTask.taskId))
							.for('update', { noWait: true }),
					)
					.pipe(Effect.flip),
			).toMatchObject({ code: '55P03' })
			const deleting = yield* Deferred.succeed(deletionStarted, undefined).pipe(
				Effect.andThen(deleteArchived({ organizationId, userId: seeded.me, expectedCount: 2 })),
				Effect.flip,
				Effect.forkChild,
			)
			yield* Deferred.await(deletionStarted)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(unarchiving)
			// Whether the delete read before or after the commit, the unarchived task isn't counted.
			expect(yield* Fiber.join(deleting)).toMatchObject({ _tag: 'CountChanged', expected: 2, actual: 1 })
			expect(yield* Effect.promise(() => remaining(seeded.own))).toEqual({ tasks: 2, sessions: 2 })
			// Confirming the new count deletes only the task still archived.
			expect(yield* deleteArchived({ organizationId, userId: seeded.me, expectedCount: 1 })).toEqual({
				deletedCount: 1,
			})
			expect(yield* Effect.promise(() => remaining([unarchivedTask]))).toEqual({ tasks: 1, sessions: 2 })
		}).pipe(Effect.provide(Layer.mergeAll(PostgresDbLive(db), streamCleanup))),
	)
})
