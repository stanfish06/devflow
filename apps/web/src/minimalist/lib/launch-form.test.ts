import type { Task } from '@devflow/db/tables/tasks'
import type { ProjectRepository } from '@devflow/schemas/effect/project-workspace'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
	type DraftLaunch,
	draftSaveInput,
	fromDraftLaunch,
	isBoardDraft,
	launchInput,
	NEWER_DRAFT_ERROR,
	ticketFromTask,
	toDraftLaunch,
	toStartInput,
} from '@/minimalist/lib/launch-form'
import type { ComposerSettings } from '@/minimalist/lib/models'
import type { TaskSize } from '@/minimalist/lib/task-size'
import type { Ticket } from '@/minimalist/lib/tickets'

const taskId = '019ab7c2-4f1e-7000-8000-00000000d1a7'
const projectId = '019ab7c2-4f1e-7000-8000-0000000000aa'
const project = {
	id: projectId,
	repositories: [
		{
			remoteUrl: 'git@github.com:acme/app.git',
			repositoryIdentity: 'github.com/acme/app',
			defaultBranch: 'main',
			default: true,
			autoPushBranch: false,
			copyGlobs: [],
		},
	] as unknown as ProjectRepository[],
}
const settings: ComposerSettings = {
	agent: 'claude',
	model: 'opus',
	effort: 'high',
	fastMode: false,
	permissionsMode: 'accept_edits',
}
const ticket: Ticket = {
	provider: 'github',
	ticketId: '42',
	name: '[acme/app#42] Webhooks drop events',
	slug: 'acme-app-42-webhooks-drop-events',
	url: 'https://github.com/acme/app/issues/42',
	githubRepository: {
		connectionId: '11111111-1111-4111-8111-111111111111',
		repositoryId: '9007',
		fullName: 'acme/app',
		accountLogin: 'acme',
		private: false,
		archived: false,
	},
}
const attachment = {
	fileName: 'uploads/019ab7c2-4f1e-7000-8000-0000000000bb-errors.log',
	contentType: 'text/plain',
	fileSizeBytes: 12,
	contentHash: 'a'.repeat(64),
}

function snapshot(overrides: Partial<DraftLaunch> = {}): DraftLaunch {
	const saved = toDraftLaunch({
		text: 'Retry with backoff',
		target: { kind: 'project', projectId },
		hostId: 'laptop',
		settings,
		taskSize: 'small',
		smallAutoAdvance: false,
		attachments: [attachment],
	})
	return { ...saved, ...overrides }
}

/** The task row `tasks.saveDraft` leaves behind, as the tasks collection syncs it. */
function savedRow(launch: DraftLaunch, withTicket: Ticket | null): Task {
	const input = draftSaveInput({ taskId, snapshot: launch, ticket: withTicket, status: 'todo' })
	return {
		id: taskId,
		name: input.name,
		slug: input.slug,
		is_draft: true,
		archived: false,
		status: input.status,
		project_id: null,
		workspace_id: null,
		default_working_directory: input.defaultWorkingDirectory,
		ticket_id: input.ticketId,
		ticket_url: null,
		ticket_provider: input.ticketProvider,
		github_connection_id: input.githubConnectionId,
		ticket_repository_id: input.ticketRepositoryId,
		ticket_repository_full_name: input.ticketRepositoryFullName,
		draft_launch: JSON.parse(JSON.stringify(input.draftLaunch)) as unknown,
	} as Task
}

describe('a draft snapshot', () => {
	it('pins the composer types to the snapshot the server validates', () => {
		expectTypeOf<DraftLaunch['settings']>().toEqualTypeOf<ComposerSettings>()
		expectTypeOf<DraftLaunch['taskSize']>().toEqualTypeOf<TaskSize>()
	})

	it('reopens exactly as it was saved, ticket included', () => {
		const launch = snapshot()
		const { seed, error } = fromDraftLaunch(savedRow(launch, ticket))
		expect(error).toBeNull()
		expect(seed).toEqual({
			text: 'Retry with backoff',
			target: { kind: 'project', projectId },
			hostId: 'laptop',
			settings,
			ticket,
			taskSize: 'small',
			smallAutoAdvance: false,
			attachments: [attachment],
		})
		expect(toDraftLaunch({ ...seed, target: seed.target ?? launch.target, hostId: seed.hostId ?? '' })).toEqual(
			launch,
		)
	})

	it('opens blank, saying why, when a newer version saved it', () => {
		const row = savedRow(snapshot(), null)
		const { seed, error } = fromDraftLaunch({ ...row, draft_launch: { version: 2, prompt: 'From the future' } })
		expect(error).toBe(NEWER_DRAFT_ERROR)
		expect(seed).toMatchObject({ text: '', target: null, attachments: [] })
	})

	it('is a board draft only with a snapshot; the standard launcher keeps the rest', () => {
		expect(isBoardDraft(savedRow(snapshot(), null))).toBe(true)
		expect(isBoardDraft({ is_draft: true, draft_launch: null })).toBe(false)
		expect(isBoardDraft({ is_draft: false, draft_launch: null })).toBe(false)
	})

	it('files the row like the ticket it becomes: name, slug, ticket, workflow and column', () => {
		const withTicket = draftSaveInput({ taskId, snapshot: snapshot(), ticket, status: 'backlog' })
		expect(withTicket).toMatchObject({
			id: taskId,
			name: ticket.name,
			slug: ticket.slug,
			defaultWorkingDirectory: null,
			ticketProvider: 'github',
			ticketId: '42',
			githubConnectionId: ticket.githubRepository.connectionId,
			ticketRepositoryId: '9007',
			ticketRepositoryFullName: 'acme/app',
			workflowType: 'oneshot',
			worktreeTiming: 'now',
			autoAdvanceImplementationToPr: false,
			status: 'backlog',
		})
		const plain = draftSaveInput({
			taskId,
			snapshot: snapshot({ target: { kind: 'directory', path: '/code/app' }, taskSize: 'medium' }),
			ticket: null,
			status: 'todo',
		})
		expect(plain).toMatchObject({
			name: 'Retry with backoff',
			slug: 'retry-with-backoff-d1a7',
			defaultWorkingDirectory: '/code/app',
			ticketProvider: null,
			githubConnectionId: null,
			workflowType: 'outline_only',
			worktreeTiming: 'never',
			autoAdvanceQuestionsToResearch: true,
		})
	})

	it('reads a GitHub issue back from the row, with its link', () => {
		const row = savedRow(snapshot(), ticket)
		expect(ticketFromTask(row)).toEqual(ticket)
		expect(ticketFromTask(savedRow(snapshot(), null))).toBeNull()
	})
})

describe('starting a draft', () => {
	const ids = { sessionId: '019ab7c2-4f1e-7000-8000-0000000000c1', eventId: '019ab7c2-4f1e-7000-8000-0000000000c2' }

	it('launches what the composer would have, with the draft id as the task id and no column', () => {
		const launch = snapshot()
		const row = savedRow(launch, ticket)
		// What the new-task composer passes `startTask` for the same picks today.
		const composer = {
			ids: { taskId, ...ids },
			target: { kind: 'project' as const, project },
			hostId: 'laptop',
			draft: 'Retry with backoff',
			ticket,
			attachments: [attachment],
			settings,
			workflow: { workflowType: 'oneshot' as const, autoAdvance: false },
			directImplementation: true,
		}
		expect(toStartInput(row, project, ids)).toEqual(composer)
		expect(launchInput({ ids: { taskId, ...ids }, target: composer.target, snapshot: launch, ticket })).toEqual(
			composer,
		)
		expect(
			launchInput({ ids: { taskId, ...ids }, target: composer.target, snapshot: launch, ticket, status: 'todo' }),
		).toEqual({ ...composer, status: 'todo' })
	})

	it('runs a directory draft in its directory', () => {
		const row = savedRow(snapshot({ target: { kind: 'directory', path: '/code/app' } }), null)
		expect(toStartInput(row, undefined, ids)).toMatchObject({
			target: { kind: 'directory', path: '/code/app' },
			ticket: null,
		})
	})

	it("refuses when the draft's project isn't the one loaded, or the snapshot can't be read", () => {
		const row = savedRow(snapshot(), null)
		expect(() => toStartInput(row, undefined, ids)).toThrow("This draft's project isn't available")
		expect(() => toStartInput({ ...row, draft_launch: { version: 2 } }, project, ids)).toThrow(NEWER_DRAFT_ERROR)
	})
})
