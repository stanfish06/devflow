import type { ProjectV2, ProjectLocationV2, ProjectMutationFields } from '@devflow/api-contract/api/projects-v2/schemas'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { projects, projectSelectSchema } from '@devflow/db/tables/projects'
import { tasks } from '@devflow/db/tables/tasks'
import { userSettings } from '@devflow/db/tables/user-settings'
import { workspaces } from '@devflow/db/tables/workspaces'
import type {
	ProjectRepositories,
	ProjectRepositoryPaths,
	RepositorySourceSelections,
} from '@devflow/schemas/effect/project-workspace'
import { hasRepositoryUrlCredentials, normalizeRepositoryIdentity } from '@devflow/schemas/effect/project-workspace'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { Clock, Effect } from 'effect'

import { PostgresDb, type PostgresTransaction } from '../services/postgres/postgres-db.service'
import { deleteTasksInTransaction, deleteTaskStreams } from '../task-deletion/delete-tasks'
import { CountChanged } from '../task-deletion/errors'
import {
	ProjectLocationInvalid,
	ProjectMutationForbidden,
	ProjectNotFound,
	ProjectPersistenceUnavailable,
	ProjectsV2Disabled,
	RepositorySourcesInvalid,
} from './errors'
import { projectReadableByActor } from './project-authorization'
import { generateProjectWorkspaceId } from './project-workspace-id'
import {
	readCheckoutHostsWithExecutor,
	readRepositoryLocationsWithExecutor,
	repositoryLocationsByIdentity,
	selectRepositoryLocationsWithExecutor,
	upsertRepositorySourcePreferencesWithExecutor,
} from './repository-locations'

export type { ProjectV2, ProjectLocationV2, ProjectMutationFields } from '@devflow/api-contract/api/projects-v2/schemas'
export type ProjectActorContext = Pick<ProjectLocationV2, 'organizationId' | 'userId'>

export const listProjects = Effect.fn('project_workspace.list_projects')(function* (input: {
	readonly actor: ProjectActorContext
	readonly archived: boolean
}) {
	const postgres = yield* PostgresDb
	const rows = yield* observePersistenceFailure(
		'list_projects',
		postgres.query(
			postgres.client
				.select()
				.from(projects)
				.where(and(projectReadableByActor(input.actor), eq(projects.archived, input.archived)))
				.orderBy(asc(projects.name), asc(projects.id)),
		),
	)
	return yield* projectsForActor(postgres, input.actor, rows)
})

export const getProject = Effect.fn('project_workspace.get_project')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
	readonly hostId?: string
}) {
	const postgres = yield* PostgresDb
	const rows = yield* observePersistenceFailure(
		'get_project',
		postgres.query(
			postgres.client
				.select()
				.from(projects)
				.where(and(projectReadableByActor(input.actor), eq(projects.id, input.projectId)))
				.limit(1),
		),
	)
	const row = rows[0]
	if (!row) return yield* new ProjectNotFound({ projectId: input.projectId })

	let location: ProjectLocationV2 | null = null
	if (input.hostId !== undefined) {
		location = yield* projectLocationProjection(postgres, {
			actor: input.actor,
			project: row,
			hostId: input.hostId,
		})
	}

	return { project: yield* projectForActor(postgres, input.actor, row), location }
})

export const createProject = Effect.fn('project_workspace.create_project')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId?: string
	readonly initialLocation?: { readonly hostId: string; readonly repositoryPaths: ProjectRepositoryPaths }
	readonly project: ProjectMutationFields
}) {
	const postgres = yield* PostgresDb
	yield* validateRecipe(input.project.repositories)
	if (input.initialLocation !== undefined)
		yield* validateProjectPaths(input.project, input.initialLocation.repositoryPaths)
	const projectId = input.projectId ?? (yield* generateProjectWorkspaceId())

	return yield* observePersistenceFailure(
		'create_project',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				if (input.initialLocation !== undefined)
					yield* requireHostBelongsToUser(transaction, input.actor, input.initialLocation.hostId)
				const [projectRow] = yield* transaction.query(
					transaction.client
						.insert(projects)
						.values({
							id: projectId,
							organization_id: input.actor.organizationId,
							name: input.project.name,
							description: input.project.description ?? null,
							private: input.project.private,
							created_by: input.actor.userId,
							resource_owner_user_id: input.actor.userId,
							repositories: input.project.repositories,
							archived: false,
						})
						.returning(),
				)
				if (!projectRow) return yield* new ProjectPersistenceUnavailable({ operation: 'create_project' })

				if (input.initialLocation === undefined) {
					return { project: yield* projectForActor(transaction, input.actor, projectRow), location: null }
				}
				yield* selectRepositoryLocationsWithExecutor(transaction, {
					...input.actor,
					hostId: input.initialLocation.hostId,
					repositoryPaths: input.initialLocation.repositoryPaths,
				})
				const location = yield* projectLocationProjection(transaction, {
					actor: input.actor,
					project: projectRow,
					hostId: input.initialLocation.hostId,
				})
				return { project: yield* projectForActor(transaction, input.actor, projectRow), location }
			}),
		),
	)
})

export const updateProject = Effect.fn('project_workspace.update_project')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
	readonly changes: Partial<ProjectMutationFields>
}) {
	const postgres = yield* PostgresDb
	if (input.changes.repositories) yield* validateRecipe(input.changes.repositories)
	return yield* observePersistenceFailure(
		'update_project',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				yield* requireProjectOwner(transaction, input.actor, input.projectId)
				const [row] = yield* transaction.query(
					transaction.client
						.update(projects)
						.set({
							name: input.changes.name,
							description: input.changes.description,
							private: input.changes.private,
							repositories: input.changes.repositories,
							updated_at: BigInt(yield* Clock.currentTimeMillis),
						})
						.where(
							and(
								eq(projects.organization_id, input.actor.organizationId),
								eq(projects.id, input.projectId),
							),
						)
						.returning(),
				)
				if (!row) return yield* new ProjectNotFound({ projectId: input.projectId })
				return yield* projectForActor(transaction, input.actor, row)
			}),
		),
	)
})

export const archiveProject = Effect.fn('project_workspace.archive_project')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
	readonly archived: boolean
}) {
	const postgres = yield* PostgresDb
	return yield* observePersistenceFailure(
		'archive_project',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				yield* requireProjectOwner(transaction, input.actor, input.projectId)
				const [row] = yield* transaction.query(
					transaction.client
						.update(projects)
						.set({ archived: input.archived, updated_at: BigInt(yield* Clock.currentTimeMillis) })
						.where(
							and(
								eq(projects.organization_id, input.actor.organizationId),
								eq(projects.id, input.projectId),
							),
						)
						.returning(),
				)
				if (!row) return yield* new ProjectNotFound({ projectId: input.projectId })
				return yield* projectForActor(transaction, input.actor, row)
			}),
		),
	)
})

/**
 * What deleting a project would remove, for its owner's confirmation: every task in it, archived
 * ones and teammates' private ones included, which the owner's browser can't count itself.
 */
export const previewProjectDelete = Effect.fn('project_workspace.preview_project_delete')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
}) {
	const postgres = yield* PostgresDb
	return yield* observePersistenceFailure(
		'preview_project_delete',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				yield* requireProjectOwner(transaction, input.actor, input.projectId)
				const rows = yield* transaction.query(projectTasksQuery(transaction, input.actor, input.projectId))
				return {
					taskCount: rows.length,
					otherPeoplesTaskCount: rows.filter((row) => row.ownerUserId !== input.actor.userId).length,
				}
			}),
		),
	)
})

/**
 * Permanently delete a project the actor owns, with all of its tasks. Follows `hosts.delete`:
 * the project is locked and its owner checked after the lock, then its workspaces and tasks are
 * locked and counted. If the count isn't the one the owner confirmed, nothing is deleted.
 *
 * The locks keep the count honest until commit. A new task in the project, or in one of its
 * workspaces, waits on its FK check against the locked row and then fails, and a task can't move
 * into or out of the project while it's locked.
 *
 * The tasks go through the shared task deletion, so their sessions and artifacts don't outlive
 * them. The project delete then cascades its workspaces, workspace locations and repository
 * status. Repository locations are keyed by repository, not project, and stay, like everything on
 * hosts and GitHub.
 */
export const deleteProject = Effect.fn('project_workspace.delete_project')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
	readonly expectedTaskCount: number
}) {
	const postgres = yield* PostgresDb
	const deleted = yield* observePersistenceFailure(
		'delete_project',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				yield* lockOwnedProject(transaction, input.actor, input.projectId)
				yield* transaction.query(
					transaction.client
						.select({ id: workspaces.id })
						.from(workspaces)
						.where(
							and(
								eq(workspaces.organization_id, input.actor.organizationId),
								eq(workspaces.project_id, input.projectId),
							),
						)
						.for('update'),
				)
				const rows = yield* transaction.query(
					projectTasksQuery(transaction, input.actor, input.projectId).for('update'),
				)
				if (rows.length !== input.expectedTaskCount)
					return yield* new CountChanged({ expected: input.expectedTaskCount, actual: rows.length })
				const taskIds = rows.map((row) => row.id)
				const { sessionIds } = yield* deleteTasksInTransaction(transaction, {
					organizationId: input.actor.organizationId,
					taskIds,
				})
				yield* transaction.query(
					transaction.client
						.delete(projects)
						.where(
							and(
								eq(projects.organization_id, input.actor.organizationId),
								eq(projects.id, input.projectId),
							),
						),
				)
				return { taskIds, sessionIds }
			}),
		),
	)

	// After commit, and off the request path: the rows are already gone either way.
	yield* Effect.forkDetach(
		deleteTaskStreams({
			organizationId: input.actor.organizationId,
			taskIds: deleted.taskIds,
			sessionIds: deleted.sessionIds,
		}),
	)
	return { deletedTaskCount: deleted.taskIds.length }
})

export const upsertProjectLocation = Effect.fn('project_workspace.upsert_project_location')(function* (input: {
	readonly actor: ProjectActorContext
	readonly projectId: string
	readonly hostId: string
	readonly repositoryPaths: ProjectRepositoryPaths
}) {
	const postgres = yield* PostgresDb
	return yield* observePersistenceFailure(
		'upsert_project_location',
		postgres.transaction((transaction) =>
			Effect.gen(function* () {
				yield* requireProjectsV2Enabled(transaction, input.actor)
				const project = yield* requireProjectInOrganization(transaction, input.actor, input.projectId)
				yield* requireHostBelongsToUser(transaction, input.actor, input.hostId)
				yield* validateProjectPaths(
					{
						name: project.name,
						private: project.private,
						repositories: project.repositories,
					},
					input.repositoryPaths,
				)
				yield* selectRepositoryLocationsWithExecutor(transaction, {
					...input.actor,
					hostId: input.hostId,
					repositoryPaths: input.repositoryPaths,
				})
				return (
					(yield* projectLocationProjection(transaction, {
						actor: input.actor,
						project,
						hostId: input.hostId,
					})) ?? {
						projectId: input.projectId,
						organizationId: input.actor.organizationId,
						userId: input.actor.userId,
						hostId: input.hostId,
						repositoryPaths: {},
						createdAt: Number(project.created_at),
						updatedAt: Number(project.updated_at),
					}
				)
			}),
		),
	)
})

export const getProjectRepositorySources = Effect.fn('project_workspace.get_project_repository_sources')(
	function* (input: { readonly actor: ProjectActorContext; readonly projectId: string; readonly hostId: string }) {
		const postgres = yield* PostgresDb
		return yield* observePersistenceFailure(
			'get_project_repository_sources',
			postgres.transaction((transaction) =>
				Effect.gen(function* () {
					yield* requireProjectsV2Enabled(transaction, input.actor)
					const project = yield* requireReadableProject(transaction, input.actor, input.projectId)
					yield* requireHostBelongsToUser(transaction, input.actor, input.hostId)
					return yield* projectRepositorySourcesProjection(transaction, {
						actor: input.actor,
						project,
						hostId: input.hostId,
					})
				}),
			),
		)
	},
)

export const upsertProjectRepositorySources = Effect.fn('project_workspace.upsert_project_repository_sources')(
	function* (input: {
		readonly actor: ProjectActorContext
		readonly projectId: string
		readonly hostId: string
		readonly sources: RepositorySourceSelections
	}) {
		const postgres = yield* PostgresDb
		return yield* observePersistenceFailure(
			'upsert_project_repository_sources',
			postgres.transaction((transaction) =>
				Effect.gen(function* () {
					yield* requireProjectsV2Enabled(transaction, input.actor)
					const project = yield* requireReadableProject(transaction, input.actor, input.projectId)
					yield* requireHostBelongsToUser(transaction, input.actor, input.hostId)
					yield* validateRepositorySourceIdentities(project.repositories, input.sources)
					yield* upsertRepositorySourcePreferencesWithExecutor(transaction, {
						...input.actor,
						hostId: input.hostId,
						sources: input.sources,
					})
					return yield* projectRepositorySourcesProjection(transaction, {
						actor: input.actor,
						project,
						hostId: input.hostId,
					})
				}),
			),
		)
	},
)

function requireProjectsV2Enabled(transaction: PostgresTransaction, actor: ProjectActorContext) {
	return transaction
		.query(
			transaction.client
				.select({ enabled: userSettings.projects_v2_enabled })
				.from(userSettings)
				.where(
					and(eq(userSettings.organization_id, actor.organizationId), eq(userSettings.user_id, actor.userId)),
				)
				.limit(1),
		)
		.pipe(Effect.flatMap((rows) => (rows[0]?.enabled ? Effect.void : new ProjectsV2Disabled())))
}

function requireHostBelongsToUser(transaction: PostgresTransaction, actor: ProjectActorContext, hostId: string) {
	return transaction
		.query(
			transaction.client
				.select({ hostId: onlineHosts.host_id })
				.from(onlineHosts)
				.where(
					and(
						eq(onlineHosts.organization_id, actor.organizationId),
						eq(onlineHosts.user_id, actor.userId),
						eq(onlineHosts.host_id, hostId),
					),
				)
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0]
					? Effect.void
					: new ProjectLocationInvalid({ message: 'The selected host is not registered for this user' }),
			),
		)
}

function requireProjectInOrganization(transaction: PostgresTransaction, actor: ProjectActorContext, projectId: string) {
	return transaction
		.query(
			transaction.client
				.select()
				.from(projects)
				.where(and(eq(projects.organization_id, actor.organizationId), eq(projects.id, projectId)))
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : new ProjectNotFound({ projectId }))),
			Effect.flatMap(parseStoredProject),
		)
}

function requireReadableProject(transaction: PostgresTransaction, actor: ProjectActorContext, projectId: string) {
	return transaction
		.query(
			transaction.client
				.select()
				.from(projects)
				.where(and(projectReadableByActor(actor), eq(projects.id, projectId)))
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : new ProjectNotFound({ projectId }))),
			Effect.flatMap(parseStoredProject),
		)
}

function requireProjectOwner(transaction: PostgresTransaction, actor: ProjectActorContext, projectId: string) {
	return requireProjectInOrganization(transaction, actor, projectId).pipe(
		Effect.flatMap((project) =>
			project.resource_owner_user_id === actor.userId
				? Effect.succeed(project)
				: new ProjectMutationForbidden({ projectId }),
		),
	)
}

/** `requireProjectOwner`, checked on the project row after locking it for the rest of the transaction. */
function lockOwnedProject(transaction: PostgresTransaction, actor: ProjectActorContext, projectId: string) {
	return Effect.gen(function* () {
		const [project] = yield* transaction.query(
			transaction.client
				.select({ ownerUserId: projects.resource_owner_user_id })
				.from(projects)
				.where(and(eq(projects.organization_id, actor.organizationId), eq(projects.id, projectId)))
				.for('update'),
		)
		if (project === undefined) return yield* new ProjectNotFound({ projectId })
		if (project.ownerUserId !== actor.userId) return yield* new ProjectMutationForbidden({ projectId })
	})
}

/**
 * Every task a project delete takes with it, archived ones included: the tasks the FK cascades
 * would reach, through `tasks.project_id` and through the project's workspaces.
 */
function projectTasksQuery(db: PostgresTransaction, actor: ProjectActorContext, projectId: string) {
	const projectWorkspaces = db.client
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(and(eq(workspaces.organization_id, actor.organizationId), eq(workspaces.project_id, projectId)))
	return db.client
		.select({ id: tasks.id, ownerUserId: tasks.resource_owner_user_id })
		.from(tasks)
		.where(
			and(
				eq(tasks.organization_id, actor.organizationId),
				or(eq(tasks.project_id, projectId), inArray(tasks.workspace_id, projectWorkspaces)),
			),
		)
}

function validateProjectPaths(project: ProjectMutationFields, paths: ProjectRepositoryPaths) {
	return Effect.gen(function* () {
		yield* validateRecipe(project.repositories)
		const expected = new Set(project.repositories.map((repository) => repository.repositoryIdentity))
		const actual = Object.keys(paths)
		if (actual.some((identity) => !expected.has(identity))) {
			return yield* new ProjectLocationInvalid({
				message: 'Filesystem mappings must reference repositories in the project',
			})
		}
	})
}

function validateRepositorySourceIdentities(repositories: ProjectRepositories, sources: RepositorySourceSelections) {
	const expected = new Set(repositories.map((repository) => repository.repositoryIdentity))
	return Object.keys(sources).some((identity) => !expected.has(identity))
		? Effect.fail(
				new RepositorySourcesInvalid({
					message: 'Repository sources must reference repositories in the project',
				}),
			)
		: Effect.void
}

function validateRecipe(repositories: ProjectRepositories): Effect.Effect<void, ProjectLocationInvalid> {
	if (repositories.some((repository) => hasRepositoryUrlCredentials(repository.remoteUrl))) {
		return Effect.fail(
			new ProjectLocationInvalid({ message: 'Repository URLs must not contain embedded credentials' }),
		)
	}
	const invalidRepository = repositories.find(
		(repository) => normalizeRepositoryIdentity(repository.remoteUrl) !== repository.repositoryIdentity,
	)
	return invalidRepository
		? Effect.fail(
				new ProjectLocationInvalid({
					message: 'Repository identity does not match remote URL',
				}),
			)
		: Effect.void
}

const parseStoredProject = Effect.fn('project_workspace.parse_stored_project')(function* (
	row: typeof projects.$inferSelect,
) {
	const parsed = projectSelectSchema.safeParse(row)
	if (!parsed.success) {
		yield* Effect.logError(parsed.error)
		return yield* new ProjectPersistenceUnavailable({ operation: 'parse_project' })
	}
	return parsed.data
})

/**
 * Projects as the actor sees them, each with the actor's hosts that hold an existing checkout of
 * any of its repositories. One location read covers every row.
 */
const projectsForActor = Effect.fn('project_workspace.projects_for_actor')(function* (
	db: PostgresTransaction,
	actor: ProjectActorContext,
	rows: readonly (typeof projects.$inferSelect)[],
) {
	const parsed = yield* Effect.forEach(rows, parseStoredProject)
	const checkoutHosts = yield* readCheckoutHostsWithExecutor(db, {
		...actor,
		repositoryIdentities: parsed.flatMap((project) =>
			project.repositories.map((repository) => repository.repositoryIdentity),
		),
	})
	return parsed.map((project) => {
		const checkoutHostIds = [
			...new Set(
				project.repositories.flatMap((repository) => checkoutHosts.get(repository.repositoryIdentity) ?? []),
			),
		].sort()
		return {
			id: project.id,
			organizationId: project.organization_id,
			name: project.name,
			description: project.description,
			private: project.private,
			createdBy: project.created_by,
			resourceOwnerUserId: project.resource_owner_user_id,
			repositories: project.repositories,
			archived: project.archived,
			createdAt: Number(project.created_at),
			updatedAt: Number(project.updated_at),
			checkoutHostIds,
		} satisfies ProjectV2
	})
})

const projectForActor = Effect.fn('project_workspace.project_for_actor')(function* (
	db: PostgresTransaction,
	actor: ProjectActorContext,
	row: typeof projects.$inferSelect,
) {
	const [project] = yield* projectsForActor(db, actor, [row])
	if (!project) return yield* new ProjectPersistenceUnavailable({ operation: 'parse_project' })
	return project
})

const projectLocationProjection = Effect.fn('project_workspace.project_location_projection')(function* (
	transaction: PostgresTransaction,
	input: {
		readonly actor: ProjectActorContext
		readonly project: typeof projects.$inferSelect
		readonly hostId: string
	},
) {
	const project = yield* parseStoredProject(input.project)
	const locations = yield* readRepositoryLocationsWithExecutor(transaction, {
		...input.actor,
		hostId: input.hostId,
		repositoryIdentities: project.repositories.map((repository) => repository.repositoryIdentity),
	})
	if (locations.length === 0) return null
	return {
		projectId: project.id,
		organizationId: input.actor.organizationId,
		userId: input.actor.userId,
		hostId: input.hostId,
		repositoryPaths: Object.fromEntries(
			locations.flatMap((location) =>
				location.kind === 'filesystem' ? [[location.repositoryIdentity, location.path]] : [],
			),
		),
		createdAt: Math.min(...locations.map((location) => location.createdAt)),
		updatedAt: Math.max(...locations.map((location) => location.updatedAt)),
	} satisfies ProjectLocationV2
})

const projectRepositorySourcesProjection = Effect.fn('project_workspace.project_repository_sources_projection')(
	function* (
		transaction: PostgresTransaction,
		input: {
			readonly actor: ProjectActorContext
			readonly project: typeof projects.$inferSelect
			readonly hostId: string
		},
	) {
		const project = yield* parseStoredProject(input.project)
		const preferences = yield* readRepositoryLocationsWithExecutor(transaction, {
			...input.actor,
			hostId: input.hostId,
			repositoryIdentities: project.repositories.map((repository) => repository.repositoryIdentity),
		})
		const preferencesByIdentity = repositoryLocationsByIdentity(preferences)
		return {
			projectId: project.id,
			hostId: input.hostId,
			sources: Object.fromEntries(
				project.repositories.map((repository) => {
					const preference = preferencesByIdentity.get(repository.repositoryIdentity)
					if (preference?.kind === 'filesystem')
						return [repository.repositoryIdentity, { kind: 'filesystem' as const, path: preference.path }]
					if (preference?.kind === 'managed_clone')
						return [repository.repositoryIdentity, { kind: 'managed_clone' as const }]
					return [repository.repositoryIdentity, { kind: 'unknown' as const }]
				}),
			),
		}
	},
)

function observePersistenceFailure<A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) {
	return effect.pipe(Effect.withSpan(`project_workspace.persistence.${operation}`))
}
