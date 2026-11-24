import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { githubAccounts } from '@devflow/db/tables/github-accounts'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { organizations } from '@devflow/db/tables/organizations'
import { projectUserSettings } from '@devflow/db/tables/project-user-settings'
import { projects } from '@devflow/db/tables/projects'
import { repositoryLocationsForUserForHost } from '@devflow/db/tables/repository-locations-for-user-for-host'
import { sessions } from '@devflow/db/tables/sessions'
import { taskOrganizationAcl } from '@devflow/db/tables/task-organization-acl'
import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { tasks } from '@devflow/db/tables/tasks'
import { userSettings } from '@devflow/db/tables/user-settings'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Redacted } from 'effect'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { tokenCipherContext } from '../../src/effects/github-accounts/github-accounts'
import { makeTokenCipher } from '../../src/effects/github-accounts/token-cipher'
import { listGithubAccountsProcedure } from '../../src/orpc/api/github-accounts/list.effect'
import { setProjectGithubAccountProcedure } from '../../src/orpc/api/projects-v2/set-github-account.effect'
import { launchTaskDraftProcedure } from '../../src/orpc/api/tasks/launch-draft'
import { setTaskGithubAccountProcedure } from '../../src/orpc/api/tasks/set-github-account.effect'
import { createTaskV2Procedure } from '../../src/orpc/api/tasks/v2/create.effect'
import { resolveGithubTokenProcedure } from '../../src/orpc/daemon/github-accounts/resolve-token.effect'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import {
	bindProcedureToRuntime,
	createRuntimeWithTestPostgresLayer,
	TEST_GITHUB_ACCOUNT_TOKEN_KEY,
} from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const repository = {
	remoteUrl: 'git@github.com:devflow/syncopate.git',
	repositoryIdentity: 'github.com/devflow/syncopate',
	defaultBranch: 'main',
	default: true as const,
	autoPushBranch: false,
	copyGlobs: [] as string[],
}

type Person = { readonly organizationId: string; readonly userId: string; readonly hostId: string }

/**
 * The full chain a session's GitHub account resolves through — task → project → your default → the
 * host's own gh login — as written by the browser's three pickers and read by the daemon.
 */
describe('GitHub account resolution', () => {
	let db: PostgresJsDatabase
	let cleanup: (() => Promise<void>) | undefined
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer>
	let organizationId: string
	let api: {
		resolveToken: typeof resolveGithubTokenProcedure
		setTaskAccount: typeof setTaskGithubAccountProcedure
		setProjectAccount: typeof setProjectGithubAccountProcedure
		createTaskV2: typeof createTaskV2Procedure
		launchDraft: typeof launchTaskDraftProcedure
		list: typeof listGithubAccountsProcedure
	}

	beforeAll(async () => {
		const testDb = await createTestDb('github_account_resolution')
		db = testDb.db
		cleanup = testDb.cleanup
		runtime = createRuntimeWithTestPostgresLayer(db)
		api = {
			resolveToken: bindProcedureToRuntime(resolveGithubTokenProcedure, runtime),
			setTaskAccount: bindProcedureToRuntime(setTaskGithubAccountProcedure, runtime),
			setProjectAccount: bindProcedureToRuntime(setProjectGithubAccountProcedure, runtime),
			createTaskV2: bindProcedureToRuntime(createTaskV2Procedure, runtime),
			launchDraft: bindProcedureToRuntime(launchTaskDraftProcedure, runtime),
			list: bindProcedureToRuntime(listGithubAccountsProcedure, runtime),
		}
		const [organization] = await db
			.insert(organizations)
			.values({ name: 'GitHub account resolution', workos_organization_id: `org_${randomUUID()}` })
			.returning()
		if (!organization) throw new Error('Could not seed the organization')
		organizationId = organization.id
	}, 60_000)

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			await cleanup?.()
		}
	}, 30_000)

	/** A fresh user with one online host and a checkout of the repository, so they can launch tasks. */
	const newPerson = async (): Promise<Person> => {
		const person = { organizationId, userId: `user_${randomUUID()}`, hostId: `host_${randomUUID()}` }
		await db
			.insert(userSettings)
			.values({ organization_id: organizationId, user_id: person.userId, projects_v2_enabled: true })
		await db.insert(onlineHosts).values({
			organization_id: organizationId,
			user_id: person.userId,
			host_id: person.hostId,
			status: 'online',
		})
		await db.insert(repositoryLocationsForUserForHost).values({
			organization_id: organizationId,
			user_id: person.userId,
			host_id: person.hostId,
			repository_identity: repository.repositoryIdentity,
			source_kind: 'filesystem',
			source_path: '/home/user/projects/syncopate',
		})
		return person
	}

	const asUser = (person: Person) => ({
		context: createMockApiContext({
			auth: createMockApiAuth({
				userId: person.userId,
				organizationId,
				workosOrganizationId: `workos-${organizationId}`,
			}),
			services: { db, dbReadReplica: db, effectRuntime: runtime },
		}),
	})

	const asDaemon = (person: Person) => ({
		context: createMockDaemonContext({
			auth: createMockDaemonAuth(person),
			services: { db, dbReadReplica: db },
		}),
	})

	/** Store an account with its token encrypted the way githubAccounts.add does. */
	const createAccount = async (owner: Person, login: string) => {
		const githubUserId = Math.floor(Math.random() * 1_000_000_000)
		const encrypted = await Effect.runPromise(
			makeTokenCipher(TEST_GITHUB_ACCOUNT_TOKEN_KEY).encrypt(
				Redacted.make(`github_pat_${login}`),
				tokenCipherContext(owner),
			),
		)
		const [row] = await db
			.insert(githubAccounts)
			.values({
				organization_id: organizationId,
				user_id: owner.userId,
				github_user_id: githubUserId,
				login,
				name: null,
				noreply_email: `${githubUserId}+${login}@users.noreply.github.com`,
				token_iv: encrypted.iv,
				token_ciphertext: encrypted.ciphertext,
				status: 'ok',
			})
			.returning({ id: githubAccounts.id })
		if (!row) throw new Error('Could not seed the account')
		return row.id
	}

	const setDefault = (owner: Person, accountId: string | null) =>
		db
			.update(userSettings)
			.set({ default_github_account_id: accountId })
			.where(and(eq(userSettings.organization_id, organizationId), eq(userSettings.user_id, owner.userId)))

	const createProject = async (owner: Person) => {
		const projectId = uuidv7()
		await db.insert(projects).values({
			id: projectId,
			organization_id: organizationId,
			name: 'Shared project',
			created_by: owner.userId,
			resource_owner_user_id: owner.userId,
			repositories: [repository],
		})
		return projectId
	}

	/** A task in the project that the whole organization can work on. */
	const createTask = async (owner: Person, projectId: string | null) => {
		const [task] = await db
			.insert(tasks)
			.values({
				organization_id: organizationId,
				project_id: projectId,
				name: 'Resolve accounts',
				resource_owner_user_id: owner.userId,
				created_by: owner.userId,
				default_working_directory: tmpdir(),
			})
			.returning({ id: tasks.id })
		if (!task) throw new Error('Could not seed the task')
		await db.insert(taskOrganizationAcl).values({
			task_id: task.id,
			organization_id: organizationId,
			resource_owner_user_id: owner.userId,
			permission_level: 'edit',
			granted_by: owner.userId,
		})
		return task.id
	}

	const createSession = async (creator: Person, taskId: string | null) => {
		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: organizationId,
				task_id: taskId,
				resource_owner_user_id: creator.userId,
				created_by: creator.userId,
				host_id: creator.hostId,
				title: 'Account session',
				working_directory: tmpdir(),
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissions_mode: 'default',
				status: 'running',
			})
			.returning({ id: sessions.id })
		if (!session) throw new Error('Could not seed the session')
		return session.id
	}

	/** Which account the daemon would hand this session's agent: a login, or `host` for the gh login. */
	const resolvedLogin = async (person: Person, sessionId: string) => {
		const resolution = await call(api.resolveToken, { sessionId }, asDaemon(person))
		return 'useHostLogin' in resolution ? 'host' : resolution.login
	}

	const taskChoice = async (person: Person, taskId: string) => {
		const [row] = await db
			.select({
				accountId: taskUserSettings.github_account_id,
				useHostLogin: taskUserSettings.github_use_host_login,
			})
			.from(taskUserSettings)
			.where(
				and(
					eq(taskUserSettings.organization_id, organizationId),
					eq(taskUserSettings.user_id, person.userId),
					eq(taskUserSettings.task_id, taskId),
				),
			)
		return row ?? null
	}

	/** No pick stored for the task: no row, or one with neither an account nor the host login. */
	const unpicked = (choice: Awaited<ReturnType<typeof taskChoice>>) =>
		choice === null || (choice.accountId === null && !choice.useHostLogin)

	/** Me with three accounts: `work` is my default, `client` the project's, `bot` the task's. */
	const chain = async () => {
		const me = await newPerson()
		const work = await createAccount(me, 'stan-work')
		const client = await createAccount(me, 'stan-client')
		const bot = await createAccount(me, 'stan-bot')
		await setDefault(me, work)
		const projectId = await createProject(me)
		const taskId = await createTask(me, projectId)
		const sessionId = await createSession(me, taskId)
		return { me, work, client, bot, projectId, taskId, sessionId }
	}

	describe('each level wins over the next', () => {
		it('uses your default when neither the task nor the project picks', async () => {
			const { me, sessionId } = await chain()
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-work')
		})

		it("uses the project's default over yours", async () => {
			const { me, client, projectId, sessionId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-client')
		})

		it("uses the task's account over the project's and yours", async () => {
			const { me, client, bot, projectId, taskId, sessionId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await call(api.setTaskAccount, { taskId, accountId: bot }, asUser(me))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-bot')
		})

		it("uses the host's own gh login when the task picks it, over the project's and yours", async () => {
			const { me, client, projectId, taskId, sessionId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await call(api.setTaskAccount, { taskId, accountId: null }, asUser(me))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('host')
			await expect(taskChoice(me, taskId)).resolves.toEqual({ accountId: null, useHostLogin: true })
		})

		it('moves from the host login to an account when the task picks again', async () => {
			const { me, bot, taskId, sessionId } = await chain()
			await call(api.setTaskAccount, { taskId, accountId: null }, asUser(me))
			await call(api.setTaskAccount, { taskId, accountId: bot }, asUser(me))
			await expect(taskChoice(me, taskId)).resolves.toEqual({ accountId: bot, useHostLogin: false })
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-bot')
		})

		it('clears the project default with null, so yours applies again', async () => {
			const { me, client, projectId, sessionId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await call(api.setProjectAccount, { projectId, accountId: null }, asUser(me))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-work')
		})

		it("follows a workspace's project when the task's own project_id is unset", async () => {
			const { me, client, projectId } = await chain()
			const launched = await call(api.createTaskV2, launchV2Input(me, projectId), asUser(me))
			await db.update(tasks).set({ project_id: null }).where(eq(tasks.id, launched.taskId))
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await expect(resolvedLogin(me, launched.sessionId)).resolves.toBe('stan-client')
		})

		it('uses only your default for a session without a task', async () => {
			const { me } = await chain()
			const sessionId = await createSession(me, null)
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-work')
		})
	})

	describe('choices are per person', () => {
		it("resolves a teammate's session on the same task through their own chain", async () => {
			const { me, bot, client, projectId, taskId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await call(api.setTaskAccount, { taskId, accountId: bot }, asUser(me))
			const teammate = await newPerson()
			const teammateDefault = await createAccount(teammate, 'ada')
			await setDefault(teammate, teammateDefault)
			const teammateSession = await createSession(teammate, taskId)

			await expect(resolvedLogin(teammate, teammateSession)).resolves.toBe('ada')

			const adaBot = await createAccount(teammate, 'ada-bot')
			await call(api.setTaskAccount, { taskId, accountId: adaBot }, asUser(teammate))
			await expect(resolvedLogin(teammate, teammateSession)).resolves.toBe('ada-bot')
			// My pick for the task is untouched by theirs.
			await expect(taskChoice(me, taskId)).resolves.toEqual({ accountId: bot, useHostLogin: false })
		})

		it("refuses to pick someone else's account, at the task and project level", async () => {
			const { me, projectId, taskId, sessionId } = await chain()
			const teammate = await newPerson()
			const theirs = await createAccount(teammate, 'ada')

			await expect(call(api.setTaskAccount, { taskId, accountId: theirs }, asUser(me))).rejects.toMatchObject({
				code: 'NOT_FOUND',
			})
			await expect(
				call(api.setProjectAccount, { projectId, accountId: theirs }, asUser(me)),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
			await expect(taskChoice(me, taskId)).resolves.toBeNull()
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-work')
		})

		it("refuses a task or project the caller can't read", async () => {
			const { me, work } = await chain()
			const stranger = await newPerson()
			const privateProjectId = await createProject(stranger)
			await db.update(projects).set({ private: true }).where(eq(projects.id, privateProjectId))
			const [privateTask] = await db
				.insert(tasks)
				.values({
					organization_id: organizationId,
					name: 'Private task',
					resource_owner_user_id: stranger.userId,
					created_by: stranger.userId,
					default_working_directory: tmpdir(),
				})
				.returning({ id: tasks.id })
			if (!privateTask) throw new Error('Could not seed the task')

			await expect(
				call(api.setTaskAccount, { taskId: privateTask.id, accountId: work }, asUser(me)),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
			await expect(
				call(api.setProjectAccount, { projectId: privateProjectId, accountId: work }, asUser(me)),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
		})

		it('lists only your own project defaults', async () => {
			const { me, client, projectId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			const teammate = await newPerson()
			const theirs = await createAccount(teammate, 'ada')
			await call(api.setProjectAccount, { projectId, accountId: theirs }, asUser(teammate))

			await expect(call(api.list, {}, asUser(me))).resolves.toMatchObject({
				projectDefaults: { [projectId]: client },
			})
			await expect(call(api.list, {}, asUser(teammate))).resolves.toMatchObject({
				projectDefaults: { [projectId]: theirs },
			})
		})
	})

	describe('a removed account falls through', () => {
		it('to the project, then your default, then the host login', async () => {
			const { me, work, client, bot, projectId, taskId, sessionId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await call(api.setTaskAccount, { taskId, accountId: bot }, asUser(me))

			await db.delete(githubAccounts).where(eq(githubAccounts.id, bot))
			await expect(taskChoice(me, taskId)).resolves.toEqual({ accountId: null, useHostLogin: false })
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-client')

			await db.delete(githubAccounts).where(eq(githubAccounts.id, client))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('stan-work')
			await expect(call(api.list, {}, asUser(me))).resolves.toMatchObject({ projectDefaults: {} })

			await db.delete(githubAccounts).where(eq(githubAccounts.id, work))
			await expect(resolvedLogin(me, sessionId)).resolves.toBe('host')
		})
	})

	function launchV2Input(person: Person, projectId: string, overrides: Record<string, unknown> = {}) {
		const taskId = uuidv7()
		return {
			taskId,
			workspaceId: taskId,
			sessionId: uuidv7(),
			projectId,
			name: 'Launched task',
			slug: `launched-${taskId}`,
			repositories: [{ ...repository, branch: `task-${taskId}` }],
			firstSession: {
				title: null,
				text: 'Open a pull request',
				hostId: person.hostId,
				codingAgent: 'claude' as const,
				provider: 'anthropic',
				model: 'opus',
				permissionsMode: 'default' as const,
			},
			...overrides,
		}
	}

	function launchDraftInput(person: Person, overrides: Record<string, unknown> = {}) {
		const draftId = uuidv7()
		return {
			draftId,
			name: 'Directory task',
			slug: `directory-${draftId}`,
			defaultWorkingDirectory: '/repo/syncopate',
			taskContent: 'Launch this task',
			workflowType: 'oneshot' as const,
			worktreeTiming: 'never' as const,
			autoAdvanceQuestionsToResearch: false,
			autoAdvanceResearchToDesign: false,
			autoAdvancePlanToWorktree: false,
			autoAdvanceWorktreeToImplementation: false,
			autoAdvanceImplementationToPr: false,
			attachments: [],
			firstSession: {
				id: uuidv7(),
				eventId: uuidv7(),
				title: 'First session',
				text: 'Start the task',
				workingDirectory: '/repo/syncopate',
				hostId: person.hostId,
				codingAgent: 'claude' as const,
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissionsMode: 'default' as const,
			},
			...overrides,
		}
	}

	describe('picking at launch', () => {
		it('leaves an untouched chip unset, so later project defaults still reach the task', async () => {
			const { me, client, projectId } = await chain()
			const launched = await call(api.createTaskV2, launchV2Input(me, projectId), asUser(me))

			expect(unpicked(await taskChoice(me, launched.taskId))).toBe(true)
			await expect(resolvedLogin(me, launched.sessionId)).resolves.toBe('stan-work')

			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			await expect(resolvedLogin(me, launched.sessionId)).resolves.toBe('stan-client')
		})

		it('stores an explicit pick in the same transaction as the first session (tasks.v2.create)', async () => {
			const { me, bot, client, projectId } = await chain()
			await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
			const launched = await call(
				api.createTaskV2,
				launchV2Input(me, projectId, { githubAccountId: bot }),
				asUser(me),
			)

			await expect(taskChoice(me, launched.taskId)).resolves.toEqual({ accountId: bot, useHostLogin: false })
			await expect(resolvedLogin(me, launched.sessionId)).resolves.toBe('stan-bot')
		})

		it('stores an explicit host-login pick (tasks.launchDraft)', async () => {
			const { me } = await chain()
			const request = launchDraftInput(me, { githubAccountId: null })
			const launched = await call(api.launchDraft, request, asUser(me))

			await expect(taskChoice(me, launched.taskId)).resolves.toEqual({ accountId: null, useHostLogin: true })
			await expect(resolvedLogin(me, launched.firstSessionId)).resolves.toBe('host')
		})

		it('stores an explicit account pick (tasks.launchDraft), and nothing when untouched', async () => {
			const { me, bot } = await chain()
			const picked = await call(api.launchDraft, launchDraftInput(me, { githubAccountId: bot }), asUser(me))
			const untouched = await call(api.launchDraft, launchDraftInput(me), asUser(me))

			await expect(resolvedLogin(me, picked.firstSessionId)).resolves.toBe('stan-bot')
			expect(unpicked(await taskChoice(me, untouched.taskId))).toBe(true)
			await expect(resolvedLogin(me, untouched.firstSessionId)).resolves.toBe('stan-work')
		})

		it("refuses a launch that picks someone else's account, and creates nothing", async () => {
			const { me, projectId } = await chain()
			const teammate = await newPerson()
			const theirs = await createAccount(teammate, 'ada')
			const v2 = launchV2Input(me, projectId, { githubAccountId: theirs })
			const draft = launchDraftInput(me, { githubAccountId: theirs })

			await expect(call(api.createTaskV2, v2, asUser(me))).rejects.toMatchObject({ code: 'NOT_FOUND' })
			await expect(call(api.launchDraft, draft, asUser(me))).rejects.toMatchObject({ code: 'NOT_FOUND' })
			await expect(db.select().from(tasks).where(eq(tasks.id, v2.taskId))).resolves.toEqual([])
			await expect(db.select().from(tasks).where(eq(tasks.id, draft.draftId))).resolves.toEqual([])
		})
	})

	it('drops your project choices with the project', async () => {
		const { me, client, projectId } = await chain()
		await call(api.setProjectAccount, { projectId, accountId: client }, asUser(me))
		await db.delete(projects).where(eq(projects.id, projectId))
		await expect(
			db.select().from(projectUserSettings).where(eq(projectUserSettings.project_id, projectId)),
		).resolves.toEqual([])
	})
})
