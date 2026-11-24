import { randomUUID } from 'node:crypto'

import { artifacts } from '@devflow/db/tables/artifacts'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { organizationSettings } from '@devflow/db/tables/organization-settings'
import { organizations } from '@devflow/db/tables/organizations'
import { sessions } from '@devflow/db/tables/sessions'
import { taskOrganizationAcl } from '@devflow/db/tables/task-organization-acl'
import { taskWorkspaceSetupForHost } from '@devflow/db/tables/task-workspace-setup-for-host'
import { tasks } from '@devflow/db/tables/tasks'
import type { WorkspaceSetupState, WorkspaceSpec } from '@devflow/schemas/effect/workspace'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { resolveOrgDefaultTaskShareLevel } from '../../src/db/organization-settings'
import type { AppRuntime } from '../../src/effects/app-runtime'
import { createTaskProcedure } from '../../src/orpc/api/tasks/create'
import { createTaskDraftEffectProcedure } from '../../src/orpc/api/tasks/createDraft.effect'
import { saveTaskDraftProcedure as unboundSaveTaskDraftProcedure } from '../../src/orpc/api/tasks/saveDraft'
import { createMockApiAuth, createMockApiContext, createMockS3Service } from '../mocks'
import { bindProcedureToRuntime, createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

describe('api/tasks/create', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let saveTaskDraftProcedure: ReturnType<typeof unboundSaveTaskDraftProcedure.withRuntime>
	let createTaskDraftProcedure: ReturnType<typeof createTaskDraftEffectProcedure.withRuntime>

	let organizationId: string
	const workosOrganizationId = 'org_tasks_create'
	const userId = 'user_tasks_create'
	const hostId = randomUUID()
	const workspaceSpec: WorkspaceSpec = {
		specVersion: 1,
		directory: '~/src/syncopate',
		workspaceBaseDirectory: '~/.devflow/workspaces/phase-3',
		setupBlocksFirstSession: false,
		repos: [
			{
				localPath: '.',
				targetPath: '~/.devflow/workspaces/phase-3/syncopate',
				branch: 'phase-3',
				sourceRef: 'origin/main',
				setupCommand: 'bun install',
				copyGlobs: ['.env'],
				primary: true,
			},
		],
	}

	beforeAll(async () => {
		const testDb = await createTestDb('tasks_create')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		const testRuntime = createRuntimeWithTestPostgresLayer(db)
		saveTaskDraftProcedure = bindProcedureToRuntime(unboundSaveTaskDraftProcedure, testRuntime)
		createTaskDraftProcedure = bindProcedureToRuntime(createTaskDraftEffectProcedure, testRuntime)

		const [org] = await db
			.insert(organizations)
			.values({
				name: 'task create test org',
				workos_organization_id: workosOrganizationId,
			})
			.returning()

		if (!org) throw new Error('Unable to insert organization for setup')
		organizationId = org.id

		await db.insert(onlineHosts).values({
			host_id: hostId,
			user_id: userId,
			organization_id: organizationId,
		})
	}, 60000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	function makeContext({
		uid = userId,
		orgId = organizationId,
		workosOrgId = workosOrganizationId,
		s3 = createMockS3Service(),
		effectRuntime,
	}: {
		uid?: string
		orgId?: string
		workosOrgId?: string
		s3?: ReturnType<typeof createMockS3Service>
		effectRuntime?: AppRuntime
	} = {}) {
		return createMockApiContext({
			auth: createMockApiAuth({ userId: uid, organizationId: orgId, workosOrganizationId: workosOrgId }),
			services: {
				db,
				dbReadReplica: db,
				s3,
				...(effectRuntime ? { effectRuntime } : {}),
			},
		})
	}

	async function createOrg() {
		const id = randomUUID()
		const workosOrgId = `workos-org-${id}`
		const [org] = await db
			.insert(organizations)
			.values({ name: `task create org ${id}`, workos_organization_id: workosOrgId })
			.returning()

		if (!org) throw new Error('Unable to insert organization for test')
		return { orgId: org.id, workosOrgId }
	}

	async function getTaskOrgAcl(taskId: string, orgId: string) {
		const [acl] = await db
			.select()
			.from(taskOrganizationAcl)
			.where(and(eq(taskOrganizationAcl.task_id, taskId), eq(taskOrganizationAcl.organization_id, orgId)))
			.limit(1)

		return acl
	}

	function firstSessionInput() {
		return {
			title: 'Research the task',
			text: 'Create research questions',
			workingDirectory: '~/.devflow/workspaces/phase-3/syncopate',
			hostId,
			codingAgent: 'claude' as const,
			provider: 'anthropic',
			model: 'claude-sonnet-4-5',
			permissionsMode: 'default' as const,
		}
	}

	function saveDraftInput(id = uuidv7()) {
		return {
			id,
			name: 'Saved draft',
			slug: `saved-draft-${id}`,
			defaultWorkingDirectory: '/draft',
			ticketId: null,
			ticketDescription: 'Draft prompt',
			ticketProvider: null,
			githubConnectionId: null,
			ticketRepositoryId: null,
			ticketRepositoryFullName: null,
			workflowType: 'outline_only' as const,
			worktreeTiming: 'later' as const,
			autoAdvanceQuestionsToResearch: true,
			autoAdvanceResearchToDesign: true,
			autoAdvancePlanToWorktree: false,
			autoAdvanceWorktreeToImplementation: true,
			autoAdvanceImplementationToPr: false,
			status: 'todo' as const,
			draftLaunch: draftLaunch(),
		}
	}

	function draftLaunch(prompt = 'Draft prompt') {
		return {
			version: 1 as const,
			prompt,
			attachments: [attachment('uploads/notes.txt')],
			target: { kind: 'directory' as const, path: '/draft' },
			hostId,
			settings: {
				agent: 'claude' as const,
				model: 'opus',
				effort: 'high',
				fastMode: false,
				permissionsMode: 'default' as const,
			},
			taskSize: 'medium' as const,
			smallAutoAdvance: true,
		}
	}

	function attachment(
		fileName: string,
		overrides: Partial<{ contentType: string; fileSizeBytes: number; contentHash: string }> = {},
	) {
		return {
			fileName,
			contentType: overrides.contentType ?? 'text/plain',
			fileSizeBytes: overrides.fileSizeBytes ?? 12,
			contentHash: overrides.contentHash ?? 'a'.repeat(64),
		}
	}

	async function getSetupRow(taskId: string) {
		const [row] = await db
			.select()
			.from(taskWorkspaceSetupForHost)
			.where(and(eq(taskWorkspaceSetupForHost.task_id, taskId), eq(taskWorkspaceSetupForHost.host_id, hostId)))
			.limit(1)
		return row
	}

	test('creates task successfully', async () => {
		const response = await call(createTaskProcedure, { name: 'basic task' }, { context: makeContext() })

		expect(response.result).toBe('created')
		if (response.result !== 'created') {
			throw new Error('Expected a newly created task')
		}
		expect(response.task).toBeDefined()
		expect(response.task.name).toBe('basic task')
		expect(response.task.organization_id).toBe(organizationId)
		expect(response.transactionId).toBeTypeOf('string')
		expect((await getTaskOrgAcl(response.task.id, organizationId))?.permission_level).toBe('edit')
	})

	test.each(['gpt-6-sol', 'gpt-6-luna'])('atomically creates a CodeLayer Codex %s first session', async (model) => {
		const response = await call(
			createTaskProcedure,
			{
				name: `Task for ${model}`,
				firstSession: {
					...firstSessionInput(),
					codingAgent: 'codelayer',
					provider: 'codex',
					model,
					effort: 'max',
					fastMode: true,
					permissionsMode: 'bypass',
				},
			},
			{ context: makeContext() },
		)

		expect(response.firstSessionId).toBeTypeOf('string')
		const [session] = await db.select().from(sessions).where(eq(sessions.id, response.firstSessionId!))
		expect(session).toMatchObject({ model, provider: 'codex', effort: 'max', fast_mode: true })
	})

	test.each([
		['foreign owner', { is_draft: true, uid: 'foreign-owner', useForeignOrg: false }],
		['foreign organization', { is_draft: true, uid: userId, useForeignOrg: true }],
	] as const)('rejects a conflicting %s identity without launch side effects', async (_label, conflict) => {
		const taskId = uuidv7()
		const foreignOrg = conflict.useForeignOrg ? await createOrg() : null
		await db.insert(tasks).values({
			id: taskId,
			organization_id: foreignOrg?.orgId ?? organizationId,
			created_by: conflict.uid,
			resource_owner_user_id: conflict.uid,
			name: 'Conflicting identity',
			is_draft: conflict.is_draft,
		})

		await expect(
			call(
				createTaskProcedure,
				{ id: taskId, name: 'No side effects', taskContent: 'No artifact', firstSession: firstSessionInput() },
				{ context: makeContext() },
			),
		).rejects.toMatchObject({ code: 'TASK_IDENTITY_CONFLICT', data: { taskId } })
		expect(await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))).toHaveLength(0)
		expect(await db.select().from(sessions).where(eq(sessions.task_id, taskId))).toHaveLength(0)
	})

	test('promotes an owned draft in place with launch fields, side effects, timestamps, and its existing ACL', async () => {
		const taskId = uuidv7()
		const sessionId = uuidv7()
		const eventId = uuidv7()
		const saved = await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		expect(saved.result).toBe('saved')
		const acl = await getTaskOrgAcl(taskId, organizationId)
		await db
			.update(taskOrganizationAcl)
			.set({ permission_level: 'edit' })
			.where(
				and(eq(taskOrganizationAcl.task_id, taskId), eq(taskOrganizationAcl.organization_id, organizationId)),
			)
		await db
			.update(tasks)
			.set({
				created_at: 1n,
				updated_at: 2n,
				archived: true,
				setup_status: 'failed',
				setup_details: 'stale setup',
				ticket_id: 'STALE-1',
				ticket_provider: 'linear',
				workflow_type: 'rpi',
				worktree_timing: 'now',
				auto_advance_questions_to_research: true,
				created_with_experiment_flags: null,
			})
			.where(eq(tasks.id, taskId))

		const launchedAt = Date.now()
		const result = await call(
			createTaskProcedure,
			{
				id: taskId,
				name: 'Launched task',
				slug: 'launched-task',
				defaultWorkingDirectory: '/launched',
				taskContent: 'Launch prompt',
				attachments: [attachment('promoted.txt')],
				firstSession: { ...firstSessionInput(), id: sessionId, eventId },
				workflowType: 'oneshot',
				worktreeTiming: 'never',
			},
			{ context: makeContext() },
		)

		const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId))
		const aclRows = await db.select().from(taskOrganizationAcl).where(eq(taskOrganizationAcl.task_id, taskId))
		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))
		const sessionRows = await db.select().from(sessions).where(eq(sessions.task_id, taskId))
		const eventRows = await db.select().from(conversationEvents).where(eq(conversationEvents.session_id, sessionId))

		expect(result.task.id).toBe(taskId)
		expect(taskRows).toHaveLength(1)
		expect(taskRows[0]).toMatchObject({
			name: 'Launched task',
			slug: 'launched-task',
			default_working_directory: '/launched',
			archived: false,
			is_draft: false,
			setup_status: null,
			setup_details: null,
			ticket_id: null,
			ticket_provider: null,
			workflow_type: 'oneshot',
			worktree_timing: 'never',
			auto_advance_questions_to_research: false,
		})
		expect(Number(taskRows[0]!.created_at)).toBeGreaterThanOrEqual(launchedAt)
		expect(taskRows[0]!.updated_at).toBe(taskRows[0]!.created_at)
		expect(aclRows).toHaveLength(1)
		expect(aclRows[0]).toMatchObject({ id: acl?.id, permission_level: 'edit' })
		expect(artifactRows.map(({ file_name }) => file_name).sort()).toEqual(['promoted.txt', 'task.md'])
		expect(sessionRows).toEqual([expect.objectContaining({ id: sessionId, task_id: taskId })])
		expect(eventRows).toEqual([expect.objectContaining({ id: eventId, session_id: sessionId })])
		expect(await getSetupRow(taskId)).toMatchObject({ task_id: taskId, host_id: hostId })
	})

	test('rejects an active task slug conflict before task creation', async () => {
		const slug = 'taken-active-slug'
		await db.insert(tasks).values({
			id: uuidv7(),
			organization_id: organizationId,
			created_by: userId,
			resource_owner_user_id: userId,
			name: 'Existing task',
			slug,
			is_draft: false,
		})

		await expect(
			call(createTaskProcedure, { id: uuidv7(), name: 'Conflicting task', slug }, { context: makeContext() }),
		).rejects.toMatchObject({ code: 'TASK_SLUG_CONFLICT', data: { slug } })
	})

	test('rejects a slug whose only other holder is an archived task', async () => {
		const slug = 'archived-slug-still-taken'
		await db.insert(tasks).values({
			id: uuidv7(),
			organization_id: organizationId,
			created_by: userId,
			resource_owner_user_id: userId,
			name: 'Archived task',
			slug,
			is_draft: false,
			archived: true,
		})

		await expect(
			call(
				createTaskProcedure,
				{ id: uuidv7(), name: 'Reuses archived slug', slug, firstSession: firstSessionInput() },
				{ context: makeContext() },
			),
		).rejects.toMatchObject({
			code: 'TASK_SLUG_CONFLICT',
			data: {
				slug,
				message: `The name "${slug}" is already in use. The task that uses it may be archived. Choose a different name.`,
			},
		})
		expect(await db.select().from(tasks).where(eq(tasks.slug, slug))).toHaveLength(1)
	})

	test('allows a draft promotion to keep its own slug', async () => {
		const taskId = uuidv7()
		await call(
			saveTaskDraftProcedure,
			{ ...saveDraftInput(taskId), slug: 'same-draft-slug' },
			{ context: makeContext() },
		)

		await expect(
			call(
				createTaskProcedure,
				{ id: taskId, name: 'Promoted task', slug: 'same-draft-slug', firstSession: firstSessionInput() },
				{ context: makeContext() },
			),
		).resolves.toMatchObject({ result: 'created', task: { id: taskId }, firstSessionId: expect.any(String) })
	})

	test('allows a V2-style fresh task ID to launch beside a draft with the same slug', async () => {
		const slug = 'v2-draft-source-slug'
		const draftId = uuidv7()
		const launchedTaskId = uuidv7()
		await call(saveTaskDraftProcedure, { ...saveDraftInput(draftId), slug }, { context: makeContext() })

		await expect(
			call(
				createTaskProcedure,
				{ id: launchedTaskId, name: 'V2 launched task', slug, firstSession: firstSessionInput() },
				{ context: makeContext() },
			),
		).resolves.toMatchObject({ result: 'created', task: { id: launchedTaskId } })
		expect(await db.select().from(tasks).where(eq(tasks.id, draftId))).toEqual([
			expect.objectContaining({ is_draft: true, slug }),
		])
	})

	test('serializes concurrent task creation for the same organization slug', async () => {
		const slug = `concurrent-task-slug-${uuidv7()}`
		const outcomes = await Promise.allSettled(
			[uuidv7(), uuidv7()].map((id) =>
				call(
					createTaskProcedure,
					{ id, name: 'Concurrent slug task', slug, firstSession: firstSessionInput() },
					{ context: makeContext() },
				),
			),
		)

		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
		expect((outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
			code: 'TASK_SLUG_CONFLICT',
			data: { slug },
		})
		expect(
			await db
				.select()
				.from(tasks)
				.where(and(eq(tasks.organization_id, organizationId), eq(tasks.slug, slug))),
		).toHaveLength(1)
	})

	test('allows only one of two concurrent launches to create the first session', async () => {
		const taskId = uuidv7()
		await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		const inputs = [
			{
				id: taskId,
				name: 'Concurrent launch',
				firstSession: { ...firstSessionInput(), id: uuidv7(), eventId: uuidv7() },
			},
			{
				id: taskId,
				name: 'Concurrent launch',
				firstSession: { ...firstSessionInput(), id: uuidv7(), eventId: uuidv7() },
			},
		]
		const outcomes = await Promise.allSettled(
			inputs.map((input) => call(createTaskProcedure, input, { context: makeContext() })),
		)

		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
		const results = outcomes.map(
			(outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>).value,
		)
		expect(results.map(({ result }) => result).sort()).toEqual(['already-exists', 'created'])
		expect(new Set(results.map(({ firstSessionId }) => firstSessionId)).size).toBe(1)
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual([
			expect.objectContaining({ is_draft: false }),
		])
		expect(await db.select().from(sessions).where(eq(sessions.task_id, taskId))).toHaveLength(1)
	})

	test('concurrent launches sharing one task identity and attachment converge on one artifact', async () => {
		const taskId = uuidv7()
		await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		const inputs = [
			{
				id: taskId,
				name: 'Concurrent staged launch',
				attachments: [attachment('concurrent-shared.txt')],
				firstSession: { ...firstSessionInput(), id: uuidv7(), eventId: uuidv7() },
			},
			{
				id: taskId,
				name: 'Concurrent staged launch',
				attachments: [attachment('concurrent-shared.txt')],
				firstSession: { ...firstSessionInput(), id: uuidv7(), eventId: uuidv7() },
			},
		]

		const outcomes = await Promise.allSettled(
			inputs.map((input) => call(createTaskProcedure, input, { context: makeContext() })),
		)

		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
		const results = outcomes.map(
			(outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>).value,
		)
		expect(results.map(({ result }) => result).sort()).toEqual(['already-exists', 'created'])
		expect(new Set(results.map(({ firstSessionId }) => firstSessionId)).size).toBe(1)
		expect(
			await db
				.select()
				.from(artifacts)
				.where(and(eq(artifacts.task_id, taskId), eq(artifacts.file_name, 'concurrent-shared.txt'))),
		).toHaveLength(1)
		expect(await db.select().from(sessions).where(eq(sessions.task_id, taskId))).toHaveLength(1)
	})

	test('creates task-owned S3 artifacts from attachment descriptors', async () => {
		const attachments = [attachment('attachments/one.txt'), attachment('attachments/two.txt')]
		const result = await call(
			createTaskProcedure,
			{ name: 'task with attachments', attachments },
			{ context: makeContext() },
		)

		const artifactRows = await db.select().from(artifacts).where(eq(artifacts.task_id, result.task.id))
		expect(artifactRows).toEqual(
			expect.arrayContaining(
				attachments.map((uploadedAttachment) =>
					expect.objectContaining({
						file_name: uploadedAttachment.fileName,
						storage_type: 's3',
						s3_key: `${organizationId}/${result.task.id}/${uploadedAttachment.fileName}`,
						content_hash: uploadedAttachment.contentHash,
						file_size_bytes: BigInt(uploadedAttachment.fileSizeBytes),
					}),
				),
			),
		)
	})

	test('adopts attachment descriptors without calling S3', async () => {
		const getPresignedUploadUrl = vi.fn()
		const result = await call(
			createTaskProcedure,
			{ name: 'descriptor adoption does not call S3', attachments: [attachment('already-uploaded.txt')] },
			{ context: makeContext({ s3: createMockS3Service({ getPresignedUploadUrl }) }) },
		)

		expect(result.result).toBe('created')
		expect(getPresignedUploadUrl).not.toHaveBeenCalled()
	})

	test('replaying the exact launch input converges after its attachment was inserted', async () => {
		const taskId = uuidv7()
		const sessionId = uuidv7()
		const input = {
			id: taskId,
			name: 'task with replayed attachment',
			attachments: [attachment('replayed.txt')],
			firstSession: { ...firstSessionInput(), id: sessionId, eventId: uuidv7() },
		}

		await call(createTaskProcedure, input, { context: makeContext() })
		await expect(call(createTaskProcedure, input, { context: makeContext() })).resolves.toMatchObject({
			result: 'already-exists',
			task: { id: taskId },
			firstSessionId: sessionId,
		})
		expect(await db.select().from(artifacts).where(eq(artifacts.task_id, taskId))).toEqual([
			expect.objectContaining({ file_name: 'replayed.txt' }),
		])
	})

	test('returns an owned active task without a session for all launch retries', async () => {
		const taskId = uuidv7()
		await call(createTaskProcedure, { id: taskId, name: 'task without session' }, { context: makeContext() })

		await expect(
			call(
				createTaskProcedure,
				{ id: taskId, name: 'retry requesting session', firstSession: firstSessionInput() },
				{ context: makeContext() },
			),
		).resolves.toMatchObject({ result: 'already-exists', task: { id: taskId }, firstSessionId: null })

		await expect(
			call(
				createTaskProcedure,
				{ id: taskId, name: 'generic retry without session' },
				{ context: makeContext() },
			),
		).resolves.toMatchObject({ result: 'already-exists', task: { id: taskId }, firstSessionId: null })
	})

	test('rejects duplicate attachment target file names without committing a task', async () => {
		const taskId = uuidv7()
		await expect(
			call(
				createTaskProcedure,
				{
					id: taskId,
					name: 'duplicate targets',
					attachments: [attachment('duplicate.txt'), attachment('duplicate.txt')],
				},
				{ context: makeContext() },
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { message: expect.stringContaining('collide') } })
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(0)
	})

	test('rejects an attachment target that collides with the V3 task.md artifact', async () => {
		const taskId = uuidv7()
		await expect(
			call(
				createTaskProcedure,
				{
					id: taskId,
					name: 'canonical artifact collision',
					taskContent: 'Task body',
					attachments: [attachment('task.md')],
				},
				{ context: makeContext() },
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { message: expect.stringContaining('collide') } })
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(0)
	})

	test('rejects an attachment target that collides with a legacy ticket artifact', async () => {
		const taskId = uuidv7()
		await expect(
			call(
				createTaskProcedure,
				{
					id: taskId,
					name: 'legacy artifact collision',
					ticketContent: 'Ticket body',
					attachments: [attachment('ticket.md')],
				},
				{ context: makeContext() },
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST', data: { message: expect.stringContaining('collide') } })
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(0)
	})

	test('persists ticketContent for a provider-less inline task', async () => {
		const result = await call(
			createTaskProcedure,
			{ name: 'inline task', ticketContent: '# Inline body' },
			{ context: makeContext() },
		)
		const [ticket] = await db.select().from(artifacts).where(eq(artifacts.task_id, result.task.id))
		expect(ticket?.content).toBe('# Inline body')
		expect(ticket?.file_name).toBe('ticket.md')
	})

	test('writes the inline artifact as task.md when the client requests it', async () => {
		const result = await call(
			createTaskProcedure,
			{ name: 'task.md task', ticketContent: '# Inline body', ticketArtifactName: 'task.md' },
			{ context: makeContext() },
		)
		const [ticket] = await db.select().from(artifacts).where(eq(artifacts.task_id, result.task.id))
		expect(ticket?.content).toBe('# Inline body')
		expect(ticket?.file_name).toBe('task.md')
	})

	test('writes taskContent verbatim as task.md for a V3 inline task', async () => {
		const result = await call(
			createTaskProcedure,
			{ name: 'V3 inline task', taskContent: 'Investigate the stall and fix it.' },
			{ context: makeContext() },
		)
		const rows = await db.select().from(artifacts).where(eq(artifacts.task_id, result.task.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.file_name).toBe('task.md')
		expect(rows[0]?.content).toBe('Investigate the stall and fix it.')
	})

	test('writes no artifact for a V3 task with an empty prompt and no ticket', async () => {
		const result = await call(
			createTaskProcedure,
			{ name: 'V3 empty prompt', taskContent: '   ' },
			{ context: makeContext() },
		)
		expect(await db.select().from(artifacts).where(eq(artifacts.task_id, result.task.id))).toHaveLength(0)
	})

	test('atomically creates an empty done setup row and first session when no workspace spec exists', async () => {
		const result = await call(
			createTaskProcedure,
			{ name: 'task without workspace', firstSession: firstSessionInput() },
			{ context: makeContext() },
		)

		const setupRow = await getSetupRow(result.task.id)
		const [session] = await db.select().from(sessions).where(eq(sessions.task_id, result.task.id)).limit(1)

		expect(setupRow).toMatchObject({ status: 'done', error: null })
		expect(setupRow?.workspace_setup_state).toMatchObject({ specVersion: 1, repos: [] })
		expect(session).toMatchObject({ status: 'ready_for_launch', host_id: hostId })
	})

	// First-session title generation lives in tasks-create-title-generation.test.ts:
	// its @devflow/ai mock needs the isolated project because the shared `unit`
	// module registry (isolate: false) makes vi.mock order-dependent across files.

	test('creates a requested setup row from workspace spec when the client has not run setup', async () => {
		const result = await call(
			createTaskProcedure,
			{
				name: 'task awaiting workspace',
				workspaceSpec,
				firstSession: firstSessionInput(),
			},
			{ context: makeContext() },
		)

		const setupRow = await getSetupRow(result.task.id)
		expect(result.task.workspace_spec).toEqual(workspaceSpec)
		expect(result.task.worktree_timing).toBe('now')
		expect(setupRow).toMatchObject({ status: 'setup_requested', error: null })
		expect(setupRow?.workspace_setup_state.repos).toEqual([{ localPath: '.', status: 'setup_requested' }])
	})

	test('preserves a finished client setup state and derives a done setup row', async () => {
		const workspaceSetupState: WorkspaceSetupState = {
			specVersion: 1,
			startedAt: 100,
			finishedAt: 200,
			repos: [
				{
					localPath: '.',
					status: 'done',
					preflight: { resolvedSourceCommit: 'a'.repeat(40) },
					worktree: {
						targetPath: '/Users/test/.devflow/workspaces/phase-3/syncopate',
						remoteUrl: 'git@github.com:devflow/syncopate.git',
					},
					copyGlobs: { filesCopied: ['.env'] },
					setupCommand: { command: 'bun install', exitCode: 0 },
				},
			],
		}
		const result = await call(
			createTaskProcedure,
			{
				name: 'task with finished workspace',
				workspaceSpec,
				worktreeTiming: 'now',
				workspaceSetupState,
				firstSession: firstSessionInput(),
			},
			{ context: makeContext() },
		)

		const setupRow = await getSetupRow(result.task.id)
		expect(setupRow?.status).toBe('done')
		expect(setupRow?.workspace_setup_state).toEqual(workspaceSetupState)
		expect(result.task.workspace_spec?.repos[0]?.sourceCommit).toBe('a'.repeat(40))
	})

	test('preserves backwards compatibility when completed setup has an invalid source commit', async () => {
		const result = await call(
			createTaskProcedure,
			{
				name: 'task with invalid finished workspace commit',
				workspaceSpec,
				hostId,
				workspaceSetupState: {
					specVersion: 1,
					repos: [
						{
							localPath: '.',
							status: 'done',
							preflight: { resolvedSourceCommit: 'origin/main' },
						},
					],
				},
			},
			{ context: makeContext() },
		)

		expect(result.task.workspace_spec).toEqual(workspaceSpec)
		expect((await getSetupRow(result.task.id))?.status).toBe('done')
	})

	test('preserves backwards compatibility when completed setup has no source commit', async () => {
		const result = await call(
			createTaskProcedure,
			{
				name: 'task with missing finished workspace commit',
				workspaceSpec,
				hostId,
				workspaceSetupState: {
					specVersion: 1,
					repos: [{ localPath: '.', status: 'done' }],
				},
			},
			{ context: makeContext() },
		)

		expect(result.task.workspace_spec).toEqual(workspaceSpec)
		expect((await getSetupRow(result.task.id))?.status).toBe('done')
	})

	test('resolveOrgDefaultTaskShareLevel returns edit when settings row is missing and read when configured', async () => {
		const org = await createOrg()

		expect(await resolveOrgDefaultTaskShareLevel(db, org.orgId)).toBe('edit')

		await db.insert(organizationSettings).values({
			organization_id: org.orgId,
			default_task_share_level: 'read',
		})

		expect(await resolveOrgDefaultTaskShareLevel(db, org.orgId)).toBe('read')
	})

	test('creates launched task organization ACL with edit access by default', async () => {
		const org = await createOrg()

		const result = await call(createTaskProcedure, { name: 'edit-default task' }, { context: makeContext(org) })

		expect((await getTaskOrgAcl(result.task.id, org.orgId))?.permission_level).toBe('edit')
	})

	test('creates draft task organization ACL with configured org default', async () => {
		const org = await createOrg()
		await db.insert(organizationSettings).values({
			organization_id: org.orgId,
			default_task_share_level: 'edit',
		})

		const result = await call(
			createTaskDraftProcedure,
			{ name: 'edit-default draft' },
			{ context: makeContext(org) },
		)

		expect((await getTaskOrgAcl(result.task.id, org.orgId))?.permission_level).toBe('edit')
	})

	test('round-trips nullable GitHub repository identity on a draft without provider calls', async () => {
		const result = await call(
			createTaskDraftProcedure,
			{
				name: 'GitHub draft',
				ticketProvider: 'github',
				githubConnectionId: '11111111-1111-4111-8111-111111111111',
				ticketId: '482',
				ticketRepositoryId: '90071992547409931236',
				ticketRepositoryFullName: 'acme/web',
			},
			{ context: makeContext() },
		)

		expect(result.task).toMatchObject({
			ticket_provider: 'github',
			github_connection_id: '11111111-1111-4111-8111-111111111111',
			ticket_id: '482',
			ticket_repository_id: '90071992547409931236',
			ticket_repository_full_name: 'acme/web',
			is_draft: true,
		})
	})

	test('saveDraft inserts an absent identity and updates an owned draft with explicit clears and a mutable slug', async () => {
		const taskId = uuidv7()
		const inserted = await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		expect(inserted).toMatchObject({ result: 'saved', task: { id: taskId, is_draft: true } })

		const updated = await call(
			saveTaskDraftProcedure,
			{
				...saveDraftInput(taskId),
				name: 'Updated draft',
				slug: 'changed-slug',
				defaultWorkingDirectory: null,
				ticketDescription: null,
			},
			{ context: makeContext() },
		)
		expect(updated).toMatchObject({
			result: 'saved',
			task: {
				id: taskId,
				name: 'Updated draft',
				slug: 'changed-slug',
				default_working_directory: null,
				ticket_description: null,
				workflow_type: 'outline_only',
				worktree_timing: 'later',
				auto_advance_questions_to_research: true,
				auto_advance_research_to_design: true,
				auto_advance_plan_to_worktree: false,
				auto_advance_worktree_to_implementation: true,
				auto_advance_implementation_to_pr: false,
				is_draft: true,
			},
		})
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toHaveLength(1)
	})

	test('saveDraft writes the board column and the launch snapshot, and dates the draft once', async () => {
		const taskId = uuidv7()
		const first = await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		expect(first).toMatchObject({
			result: 'saved',
			task: { id: taskId, is_draft: true, status: 'todo', draft_launch: draftLaunch() },
		})
		const [saved] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(saved?.drafted_at).toEqual(expect.any(BigInt))

		await new Promise((resolve) => setTimeout(resolve, 5))
		const second = await call(
			saveTaskDraftProcedure,
			{ ...saveDraftInput(taskId), status: 'backlog', draftLaunch: draftLaunch('Edited prompt') },
			{ context: makeContext() },
		)
		expect(second).toMatchObject({
			result: 'saved',
			task: { status: 'backlog', draft_launch: draftLaunch('Edited prompt') },
		})
		const [resaved] = await db.select().from(tasks).where(eq(tasks.id, taskId))
		expect(resaved?.drafted_at).toBe(saved?.drafted_at)
		expect(resaved?.updated_at).not.toBe(saved?.updated_at)
		// A draft is a task row and nothing else: no session the daemon could launch.
		expect(await db.select().from(sessions).where(eq(sessions.task_id, taskId))).toEqual([])
	})

	test('saveDraft rejects a snapshot it does not understand', async () => {
		await expect(
			call(
				saveTaskDraftProcedure,
				{ ...saveDraftInput(), draftLaunch: { ...draftLaunch(), version: 2 as unknown as 1 } },
				{ context: makeContext() },
			),
		).rejects.toThrow()
	})

	test('saveDraft cannot turn a launched draft back into a draft', async () => {
		const taskId = uuidv7()
		await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		await call(createTaskProcedure, { id: taskId, name: 'Launched' }, { context: makeContext() })

		expect(
			await call(
				saveTaskDraftProcedure,
				{ ...saveDraftInput(taskId), name: 'Late autosave' },
				{ context: makeContext() },
			),
		).toEqual({ result: 'draft-id-unavailable' })
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual([
			expect.objectContaining({ name: 'Launched', is_draft: false }),
		])
	})

	test.each([
		['active', { is_draft: false, archived: false, uid: userId }],
		['archived', { is_draft: true, archived: true, uid: userId }],
		['foreign', { is_draft: true, archived: false, uid: 'foreign-draft-owner' }],
	] as const)('saveDraft never overwrites an %s identity', async (_label, state) => {
		const taskId = uuidv7()
		await db.insert(tasks).values({
			id: taskId,
			organization_id: organizationId,
			created_by: state.uid,
			resource_owner_user_id: state.uid,
			name: 'Protected row',
			is_draft: state.is_draft,
			archived: state.archived,
		})

		expect(await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })).toEqual({
			result: 'draft-id-unavailable',
		})
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual([
			expect.objectContaining({ name: 'Protected row', is_draft: state.is_draft, archived: state.archived }),
		])
	})

	test('a concurrent launch and save cannot resurrect the identity', async () => {
		const taskId = uuidv7()
		await call(saveTaskDraftProcedure, saveDraftInput(taskId), { context: makeContext() })
		const [launch, save] = await Promise.all([
			call(createTaskProcedure, { id: taskId, name: 'Race winner' }, { context: makeContext() }),
			call(
				saveTaskDraftProcedure,
				{ ...saveDraftInput(taskId), name: 'Racing save' },
				{ context: makeContext() },
			),
		])

		expect(launch.task).toMatchObject({ id: taskId, is_draft: false })
		expect(['saved', 'draft-id-unavailable']).toContain(save.result)
		expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual([
			expect.objectContaining({ id: taskId, name: 'Race winner', is_draft: false }),
		])
	})
})
