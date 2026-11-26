import {
	buildCreatedWithExperimentFlags,
	getTaskComposerSnapshotWithV2Default,
} from '@devflow/api-contract/api/tasks/experiment-flags'
import { artifacts } from '@devflow/db/tables/artifacts'
import { sessions } from '@devflow/db/tables/sessions'
import { tasks } from '@devflow/db/tables/tasks'
import { ORPCError } from '@orpc/server'
import { and, asc, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { Effect } from 'effect'
import { hash } from 'ohash'
import { uuidv7 } from 'uuidv7'

import { checkHostModelSettings } from '../../../db/check-host-model-settings'
import { createSessionForLaunch } from '../../../db/create-session-for-launch'
import { getTxId } from '../../../db/get-tx-id'
import { validateHostOwnership } from '../../../db/host-auth'
import { activeTaskSlugIsAllocated, lockActiveTaskSlugAllocation } from '../../../db/task-slug-allocation'
import {
	buildTaskWorkspaceAndWorkflowValues,
	createTaskWorkspaceAndWorkflowRecords,
} from '../../../db/task-workspace-and-workflow'
import type { GitHubTextTicketArtifactBundle } from '../../../effects/services/github/github.schema'
import { GitHubService } from '../../../effects/services/github/github.service'
import { normalizeSubpath } from '../../../lib/normalize-subpath'
import { buildS3Key } from '../../../lib/s3-key-builder'
import { runSessionTitleGenerationAsync } from '../../../lib/session-title-generation'
import logger from '../../../logger'
import { apiBaseOrgRequired } from '../../base'
import { slugInTaskUsedMessage } from './task-conflict-messages'

/** Provider identity becomes an artifact filename; keep it path-safe and unambiguous. */
function sanitizeArtifactFileStem(stem: string): string {
	return stem.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
}

function hasDuplicateFileNames(fileNames: readonly string[]): boolean {
	return new Set(fileNames).size !== fileNames.length
}

type DatabaseExecutor = PgDatabase<PostgresJsQueryResultHKT>
type TransactionExecutor = PgDatabase<PostgresJsQueryResultHKT>

type ImportedTicket = {
	label: string
	fileName: string
	content: string
	contentHash: string
	images: ReadonlyArray<{
		fileName: string
		contentHash: string
		contentType: string
		fileSizeBytes: number
		s3Key: string
	}>
}

/** Finds an owned active task so launch retries return the first launch instead of creating it twice. */
async function findOwnedActiveLaunch(
	db: DatabaseExecutor,
	{ taskId, organizationId, userId }: { taskId: string; organizationId: string; userId: string },
): Promise<{ task: typeof tasks.$inferSelect; firstSessionId: string | null } | null> {
	const [ownedActiveTask] = await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.id, taskId),
				eq(tasks.organization_id, organizationId),
				eq(tasks.resource_owner_user_id, userId),
				eq(tasks.is_draft, false),
				eq(tasks.archived, false),
			),
		)
		.limit(1)
	if (!ownedActiveTask) return null

	const [earliestSession] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.task_id, taskId))
		.orderBy(asc(sessions.created_at), asc(sessions.id))
		.limit(1)
	return { task: ownedActiveTask, firstSessionId: earliestSession?.id ?? null }
}

function buildImportedTicket({
	preparedGitHubImport,
}: {
	preparedGitHubImport: GitHubTextTicketArtifactBundle | null
}): ImportedTicket | null {
	if (preparedGitHubImport) {
		const { identity, ticket, images } = preparedGitHubImport
		return {
			label: `${identity.repositoryFullName}#${identity.issueNumber}`,
			fileName: `${sanitizeArtifactFileStem(`${identity.repositoryFullName}-${identity.issueNumber}`)}.md`,
			content: ticket.content,
			contentHash: ticket.contentHash,
			images,
		}
	}
	return null
}

function listPlannedArtifactFileNames({
	taskContent,
	taskMdContent,
	ticketProvider,
	ticketContent,
	ticketArtifactName,
	importedTicket,
	preparedGitHubImport,
}: {
	taskContent: string | undefined
	taskMdContent: string | null
	ticketProvider: string | null | undefined
	ticketContent: string | undefined
	ticketArtifactName: string
	importedTicket: ImportedTicket | null
	preparedGitHubImport: GitHubTextTicketArtifactBundle | null
}): string[] {
	if (taskContent !== undefined) {
		const fileNames: string[] = []
		if (taskMdContent !== null) fileNames.push('task.md')
		if (importedTicket) {
			fileNames.push(importedTicket.fileName, ...importedTicket.images.map((image) => image.fileName))
		}
		return fileNames
	}
	if (preparedGitHubImport) {
		return [ticketArtifactName, ...preparedGitHubImport.images.map((image) => image.fileName)]
	}
	if (!ticketProvider && ticketContent !== undefined) return [ticketArtifactName]
	return []
}

type TaskIdentityMaterializationResult =
	| { result: 'materialized'; task: typeof tasks.$inferSelect }
	| {
			result: 'already-exists'
			transactionId: string
			task: typeof tasks.$inferSelect
			firstSessionId: string | null
	  }
	| { result: 'identity-conflict' }

async function materializeTaskIdentity({
	tx,
	taskId,
	organizationId,
	userId,
	launchTaskValues,
}: {
	tx: TransactionExecutor
	taskId: string
	organizationId: string
	userId: string
	launchTaskValues: Omit<typeof tasks.$inferInsert, 'id'>
}): Promise<TaskIdentityMaterializationResult> {
	const [task] = await tx
		.insert(tasks)
		.values({ id: taskId, ...launchTaskValues })
		.onConflictDoUpdate({
			target: tasks.id,
			set: launchTaskValues,
			setWhere: and(
				eq(tasks.organization_id, organizationId),
				eq(tasks.resource_owner_user_id, userId),
				eq(tasks.is_draft, true),
			),
		})
		.returning()

	if (task) return { result: 'materialized', task }

	const alreadyLaunched = await findOwnedActiveLaunch(tx, { taskId, organizationId, userId })
	if (alreadyLaunched) {
		return { result: 'already-exists', transactionId: await getTxId(tx), ...alreadyLaunched }
	}
	return { result: 'identity-conflict' }
}

export const createTaskProcedure = apiBaseOrgRequired.tasks.create
	.use(async ({ context, next }, input) => {
		if (!input.id) return next({ context })

		const alreadyLaunched = await findOwnedActiveLaunch(context.services.db, {
			taskId: input.id,
			organizationId: context.auth.organizationId,
			userId: context.auth.userId,
		})
		if (!alreadyLaunched) return next({ context })

		return {
			context,
			output: {
				result: 'already-exists' as const,
				transactionId: await getTxId(context.services.db),
				...alreadyLaunched,
			},
		}
	})
	.handler(async ({ input, context, errors }) => {
		const {
			id,
			name,
			slug,
			defaultWorkingDirectory,
			workspaceState,
			workspaceSpec,
			workspaceSetupState,
			ticketContent,
			taskContent,
			ticketArtifactName,
			firstSession,
			localWorkspaceBaseDirectory,
			hostId,
			setupStatus,
			ticketId,
			ticketUrl,
			ticketDescription,
			ticketProvider,
			githubConnectionId,
			ticketRepositoryId,
			workflowType,
			worktreeTiming,
			autoAdvanceQuestionsToResearch,
			autoAdvanceResearchToDesign,
			autoAdvancePlanToWorktree,
			autoAdvanceWorktreeToImplementation,
			autoAdvanceImplementationToPr,
			createdWithExperimentFlags,
			attachments,
		} = input
		const { services } = context
		const { db } = services
		const taskId = id ?? uuidv7()
		const convergeOwnedActiveLaunch = (
			launch: NonNullable<Awaited<ReturnType<typeof findOwnedActiveLaunch>>>,
			transactionId: string,
		) => {
			return { result: 'already-exists' as const, transactionId, ...launch }
		}

		try {
			const taskWorkspaceAndWorkflowConfiguration = {
				name,
				defaultWorkingDirectory,
				workspaceState,
				workspaceSpec,
				workspaceSetupState,
				localWorkspaceBaseDirectory,
				hostId,
				setupStatus,
				workflowType,
				worktreeTiming,
				autoAdvanceQuestionsToResearch,
				autoAdvanceResearchToDesign,
				autoAdvancePlanToWorktree,
				autoAdvanceWorktreeToImplementation,
				autoAdvanceImplementationToPr,
			}
			const resolvedTaskConfiguration = buildTaskWorkspaceAndWorkflowValues(taskWorkspaceAndWorkflowConfiguration)
			const workspaceSpecForTask = resolvedTaskConfiguration.workspaceSpec

			const normalizedSlug = slug || null

			if (
				normalizedSlug &&
				(await activeTaskSlugIsAllocated(db, {
					slug: normalizedSlug,
					taskId,
					organizationId: context.auth.organizationId,
				}))
			) {
				throw errors.TASK_SLUG_CONFLICT({
					data: { slug: normalizedSlug, message: slugInTaskUsedMessage(normalizedSlug) },
				})
			}
			const modelSettings = firstSession ? await checkHostModelSettings(db, context.auth, firstSession) : null
			if (modelSettings && !modelSettings.effortSupported) {
				throw errors.BAD_REQUEST({ data: { message: 'The selected effort is not supported by this model' } })
			}
			if (modelSettings && !modelSettings.fastModeSupported) {
				throw errors.BAD_REQUEST({ data: { message: 'Fast mode is not supported by this model' } })
			}

			const importAttemptId = uuidv7()
			const taskComposerSnapshot = getTaskComposerSnapshotWithV2Default(createdWithExperimentFlags)
			const effectiveExperimentFlags = buildCreatedWithExperimentFlags(taskComposerSnapshot)
			let preparedGitHubImport: GitHubTextTicketArtifactBundle | null = null

			try {
				if (ticketProvider === 'github') {
					if (!githubConnectionId || !ticketRepositoryId || !ticketId) {
						throw errors.BAD_REQUEST({ data: { message: 'GitHub ticket identity is incomplete' } })
					}
					preparedGitHubImport = await services.effectRuntime.runPromise(
						Effect.gen(function* () {
							const github = yield* GitHubService
							return yield* github
								.prepareIssueImport({
									organizationId: context.auth.organizationId,
									taskId,
									importAttemptId,
									connectionId: githubConnectionId,
									repositoryId: ticketRepositoryId,
									issueInput: ticketId,
								})
								.pipe(
									Effect.catchTags({
										GitHubConnectionNotFoundError: () => Effect.fail(errors.NOT_FOUND()),
										GitHubRepositoryNotAccessibleError: () => Effect.fail(errors.NOT_FOUND()),
										GitHubIssueNotFoundError: () => Effect.fail(errors.NOT_FOUND()),
										GitHubIntegrationDisabledError: () =>
											Effect.fail(
												errors.BAD_REQUEST({
													data: { message: 'github_integration_disabled' },
												}),
											),
										GitHubInstallationSuspendedError: () =>
											Effect.fail(
												errors.BAD_REQUEST({
													data: { message: 'github_installation_suspended' },
												}),
											),
										GitHubMissingPermissionsError: () =>
											Effect.fail(
												errors.BAD_REQUEST({
													data: { message: 'github_issues_permission_required' },
												}),
											),
										GitHubIssueInputInvalidError: (error) =>
											Effect.fail(errors.BAD_REQUEST({ data: { message: error.reason } })),
										GitHubIntegrationUnavailableError: () =>
											Effect.fail(errors.SERVICE_UNAVAILABLE()),
									}),
								)
						}),
					)
				}
			} catch (providerError) {
				const alreadyLaunched = await findOwnedActiveLaunch(db, {
					taskId,
					organizationId: context.auth.organizationId,
					userId: context.auth.userId,
				})
				if (alreadyLaunched) return convergeOwnedActiveLaunch(alreadyLaunched, await getTxId(db))
				throw providerError
			}

			// V3 composer artifact roles: the user's prompt lives in task.md, and an
			// attached ticket becomes its own provider-named artifact referenced from
			// task.md. V2 clients keep the single ticketContent/ticketArtifactName slot.
			const importedTicket = buildImportedTicket({ preparedGitHubImport })
			const trimmedTaskContent = taskContent?.trim() ?? ''
			let taskMdContent: string | null = null
			if (taskContent !== undefined) {
				if (importedTicket) {
					taskMdContent = [trimmedTaskContent, `See [${importedTicket.label}](./${importedTicket.fileName}).`]
						.filter(Boolean)
						.join('\n\n')
				} else if (trimmedTaskContent) {
					taskMdContent = taskContent
				}
			}
			const preparedAttachments = (attachments ?? []).map((attachment) => {
				const fileName = normalizeSubpath(attachment.fileName)
				return {
					...attachment,
					fileName,
					s3Key: buildS3Key(context.auth.organizationId, taskId, fileName),
				}
			})
			const attachmentFileNames = preparedAttachments.map((attachment) => attachment.fileName)
			// Text and provider-image artifact names this request will create.
			const plannedArtifactFileNames = listPlannedArtifactFileNames({
				taskContent,
				taskMdContent,
				ticketProvider,
				ticketContent,
				ticketArtifactName,
				importedTicket,
				preparedGitHubImport,
			})
			const hasDuplicatePlannedArtifacts = hasDuplicateFileNames(plannedArtifactFileNames)
			const hasDuplicateAttachments = hasDuplicateFileNames(attachmentFileNames)
			const attachmentCollidesWithPlannedArtifact = attachmentFileNames.some((fileName) =>
				plannedArtifactFileNames.includes(fileName),
			)
			if (hasDuplicatePlannedArtifacts || hasDuplicateAttachments || attachmentCollidesWithPlannedArtifact) {
				throw errors.BAD_REQUEST({ data: { message: 'Task artifact file names collide' } })
			}

			const txResult = await db.transaction(async (tx) => {
				if (normalizedSlug) {
					await lockActiveTaskSlugAllocation(tx, {
						slug: normalizedSlug,
						organizationId: context.auth.organizationId,
					})
					if (
						await activeTaskSlugIsAllocated(tx, {
							slug: normalizedSlug,
							taskId,
							organizationId: context.auth.organizationId,
						})
					) {
						throw errors.TASK_SLUG_CONFLICT({
							data: { slug: normalizedSlug, message: slugInTaskUsedMessage(normalizedSlug) },
						})
					}
				}

				// Materialize the guarded identity first. Concurrent launches serialize
				// here, so a retry that loses the race converges before one-shot upload
				// or host validation can reject the already-committed request.
				const launchTime = BigInt(Date.now())
				const launchTaskValues = {
					...resolvedTaskConfiguration.taskValues,
					slug: normalizedSlug,
					organization_id: context.auth.organizationId,
					created_by: context.auth.userId,
					resource_owner_user_id: context.auth.userId,
					created_at: launchTime,
					updated_at: launchTime,
					team_id: null,
					project_id: null,
					external_task_id: null,
					archived: false,
					setup_details: null,
					ticket_id: preparedGitHubImport
						? String(preparedGitHubImport.identity.issueNumber)
						: (ticketId ?? null),
					ticket_url: preparedGitHubImport?.identity.url ?? ticketUrl ?? null,
					ticket_description: ticketDescription || null,
					ticket_provider: ticketProvider || null,
					github_connection_id: preparedGitHubImport ? githubConnectionId : null,
					ticket_repository_id: preparedGitHubImport?.identity.repositoryId ?? null,
					ticket_repository_full_name: preparedGitHubImport?.identity.repositoryFullName ?? null,
					is_draft: false,
					created_with_experiment_flags: effectiveExperimentFlags,
				}
				const materialization = await materializeTaskIdentity({
					tx,
					taskId,
					organizationId: context.auth.organizationId,
					userId: context.auth.userId,
					launchTaskValues,
				})
				if (materialization.result === 'already-exists') return materialization
				if (materialization.result === 'identity-conflict') {
					throw errors.TASK_IDENTITY_CONFLICT({ data: { taskId } })
				}
				const result = materialization.task

				const setupHostId = firstSession?.hostId ?? hostId
				if (firstSession) {
					const hostValid = await validateHostOwnership(
						tx,
						firstSession.hostId,
						context.auth.userId,
						context.auth.organizationId,
					)
					if (!hostValid) throw errors.FORBIDDEN({ data: { message: 'Host not found or not owned by user' } })
				}
				if (taskContent === undefined && preparedGitHubImport) {
					await tx.insert(artifacts).values([
						{
							task_id: result.id,
							task_slug: result.slug,
							resource_owner_user_id: context.auth.userId,
							organization_id: context.auth.organizationId,
							file_name: ticketArtifactName,
							content: preparedGitHubImport.ticket.content,
							content_hash: preparedGitHubImport.ticket.contentHash,
							content_type: 'text/markdown',
							file_size_bytes: BigInt(Buffer.byteLength(preparedGitHubImport.ticket.content, 'utf8')),
							created_by: context.auth.userId,
							storage_type: 'postgres' as const,
						},
						...preparedGitHubImport.images.map((image) => ({
							task_id: result.id,
							task_slug: result.slug,
							resource_owner_user_id: context.auth.userId,
							organization_id: context.auth.organizationId,
							file_name: image.fileName,
							content: '',
							content_hash: image.contentHash,
							content_type: image.contentType,
							file_size_bytes: BigInt(image.fileSizeBytes),
							created_by: context.auth.userId,
							storage_type: 's3' as const,
							s3_key: image.s3Key,
						})),
					])
				}

				if (taskContent !== undefined && (taskMdContent !== null || importedTicket)) {
					const artifactOwner = {
						task_id: result.id,
						task_slug: result.slug,
						resource_owner_user_id: context.auth.userId,
						organization_id: context.auth.organizationId,
						created_by: context.auth.userId,
					}

					if (taskMdContent !== null) {
						await tx.insert(artifacts).values({
							...artifactOwner,
							file_name: 'task.md',
							content: taskMdContent,
							content_hash: hash(taskMdContent),
							content_type: 'text/markdown',
							file_size_bytes: BigInt(Buffer.byteLength(taskMdContent, 'utf8')),
							storage_type: 'postgres',
						})
					}

					if (importedTicket) {
						const ticketArtifact = {
							...artifactOwner,
							file_name: importedTicket.fileName,
							content: importedTicket.content,
							content_hash: importedTicket.contentHash,
							content_type: 'text/markdown',
							file_size_bytes: BigInt(Buffer.byteLength(importedTicket.content, 'utf8')),
							storage_type: 'postgres' as const,
						}
						const imageArtifacts = importedTicket.images.map((image) => ({
							...artifactOwner,
							file_name: image.fileName,
							content: '',
							content_hash: image.contentHash,
							content_type: image.contentType,
							file_size_bytes: BigInt(image.fileSizeBytes),
							storage_type: 's3' as const,
							s3_key: image.s3Key,
						}))

						await tx.insert(artifacts).values([ticketArtifact, ...imageArtifacts])
					}
				}

				await createTaskWorkspaceAndWorkflowRecords(tx, {
					taskId: result.id,
					organizationId: context.auth.organizationId,
					userId: context.auth.userId,
					configuration: taskWorkspaceAndWorkflowConfiguration,
					workspaceSpec: workspaceSpecForTask,
					setupHostId,
				})

				const inlineContent = taskContent === undefined && !ticketProvider ? ticketContent : undefined

				if (inlineContent !== undefined) {
					await tx.insert(artifacts).values({
						task_id: result.id,
						task_slug: result.slug,
						file_name: ticketArtifactName,
						content: inlineContent,
						content_hash: hash(inlineContent),
						content_type: 'text/plain',
						file_size_bytes: BigInt(Buffer.byteLength(inlineContent, 'utf8')),
						storage_type: 'postgres',
						resource_owner_user_id: context.auth.userId,
						organization_id: context.auth.organizationId,
						created_by: context.auth.userId,
					})
				}

				if (preparedAttachments.length > 0) {
					await tx.insert(artifacts).values(
						preparedAttachments.map((attachment) => ({
							task_id: result.id,
							task_slug: result.slug,
							file_name: attachment.fileName,
							content: '',
							content_hash: attachment.contentHash,
							content_type: attachment.contentType,
							file_size_bytes: BigInt(attachment.fileSizeBytes),
							storage_type: 's3' as const,
							s3_key: attachment.s3Key,
							resource_owner_user_id: context.auth.userId,
							organization_id: context.auth.organizationId,
							created_by: context.auth.userId,
						})),
					)
				}

				let session = null
				if (firstSession) {
					session = await createSessionForLaunch(tx, {
						id: firstSession.id ?? undefined,
						eventId: firstSession.eventId ?? undefined,
						taskId: result.id,
						organizationId: context.auth.organizationId,
						resourceOwnerUserId: context.auth.userId,
						createdBy: context.auth.userId,
						title: firstSession.title,
						prompt: firstSession.text,
						workingDirectory: firstSession.workingDirectory,
						hostId: firstSession.hostId,
						codingAgent: firstSession.codingAgent,
						provider: firstSession.provider,
						model: firstSession.model,
						effort: firstSession.effort ?? undefined,
						fastMode: firstSession.fastMode ?? undefined,
						permissionsMode: firstSession.permissionsMode,
					})
				}

				return {
					result: 'created' as const,
					task: result,
					firstSessionId: session?.id ?? null,
					session,
					txid: await getTxId(tx),
				}
			})

			if (txResult.result === 'already-exists') return txResult

			// Fire-and-forget AI title generation for an untitled first session,
			// mirroring sessions.launch. Never blocks or fails task creation.
			if (txResult.session && !txResult.session.title && txResult.session.prompt) {
				void runSessionTitleGenerationAsync(db, {
					sessionId: txResult.session.id,
					organizationId: context.auth.organizationId,
					userId: txResult.session.created_by,
					prompt: txResult.session.prompt,
					ticketId: txResult.task.ticket_id,
					taskName: txResult.task.name,
				})
			}

			return {
				result: txResult.result,
				transactionId: txResult.txid,
				task: txResult.task,
				firstSessionId: txResult.firstSessionId,
			}
		} catch (error: unknown) {
			if (error instanceof ORPCError) throw error
			logger.error({ err: error, ticketId, ticketProvider }, 'Failed to create task')
			throw errors.INTERNAL_SERVER_ERROR({})
		}
	})
