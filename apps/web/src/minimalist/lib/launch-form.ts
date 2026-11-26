import { DraftLaunchSchema } from '@devflow/api-contract/api/tasks/draft-launch'
import type { ApiInputs } from '@devflow/api-contract/contract-router'
import type { Task } from '@devflow/db/tables/tasks'
import type { TaskStatus, WorktreeTiming } from '@devflow/schemas/effect/taskconfiguration'
import type { VmScope } from '@devflow/schemas/zod/host/agent-sandbox'
import { useState } from 'react'

import type { AttachmentMetadata } from '@/minimalist/lib/attachments'
import { projectTaskAutoAdvanceFlags } from '@/minimalist/lib/auto-advance-flags'
import { useDraft } from '@/minimalist/lib/drafts'
import { draftTitle, type LoadedTarget, savedSettings, slugify, type StartTaskInput } from '@/minimalist/lib/launch'
import type { ComposerSettings } from '@/minimalist/lib/models'
import {
	defaultVmScope,
	type TaskSize,
	taskSizeWorkflow,
	useSmallTaskAutoAdvance,
	useTaskSize,
} from '@/minimalist/lib/task-size'
import type { Ticket } from '@/minimalist/lib/tickets'
import { useAttachments } from '@/minimalist/lib/use-attachments'

/** A board draft's composer snapshot, as `tasks.saveDraft` takes it and `tasks.draft_launch` holds it. */
export type DraftLaunch = ApiInputs['tasks']['saveDraft']['draftLaunch']
export type VmSizing = Pick<DraftLaunch, 'vmCpus' | 'vmMemoryGiB'>
/** Where a draft runs, by id: a project or a directory. */
export type DraftTarget = DraftLaunch['target']
export type SaveDraftInput = ApiInputs['tasks']['saveDraft']

/** What the composer opens with: a draft's snapshot, or a blank one. */
export type LaunchFormSeed = VmSizing & {
	text: string
	target: DraftTarget | null
	hostId: string | null
	settings: ComposerSettings
	ticket: Ticket | null
	taskSize: TaskSize
	smallAutoAdvance: boolean
	/** A VM picked in the composer; null follows the task size. */
	vmScope?: VmScope | null
	attachments: AttachmentMetadata[]
}

export const NEWER_DRAFT_ERROR = 'This draft was saved by a newer version of devflow. Reload to open it.'

/** The draft's snapshot, or why it can't be read: a newer client wrote a shape this one doesn't know. */
export function parseDraftLaunch(value: unknown): { ok: true; snapshot: DraftLaunch } | { ok: false; error: string } {
	const parsed = DraftLaunchSchema.safeParse(value)
	return parsed.success ? { ok: true, snapshot: parsed.data } : { ok: false, error: NEWER_DRAFT_ERROR }
}

/** Whether a task is a board draft: saved from the composer, with a snapshot to start from. */
export function isBoardDraft(task: Pick<Task, 'is_draft' | 'draft_launch'> | null | undefined): boolean {
	return Boolean(task?.is_draft && task.draft_launch != null)
}

/** The GitHub issue a draft starts from, from the ticket fields `tasks.saveDraft` keeps on its row. */
export function ticketFromTask(
	task: Pick<
		Task,
		| 'name'
		| 'slug'
		| 'ticket_provider'
		| 'ticket_id'
		| 'ticket_url'
		| 'github_connection_id'
		| 'ticket_repository_id'
		| 'ticket_repository_full_name'
	>,
): Ticket | null {
	const fullName = task.ticket_repository_full_name
	if (
		task.ticket_provider !== 'github' ||
		!task.ticket_id ||
		!task.github_connection_id ||
		!task.ticket_repository_id ||
		!fullName
	)
		return null
	return {
		provider: 'github',
		ticketId: task.ticket_id,
		name: task.name,
		slug: task.slug ?? slugify(task.name, task.ticket_id),
		// Drafts don't store the link; a GitHub issue's is fixed by its repository and number.
		url: task.ticket_url ?? `https://github.com/${fullName}/issues/${task.ticket_id}`,
		githubRepository: {
			connectionId: task.github_connection_id,
			repositoryId: task.ticket_repository_id,
			fullName,
			accountLogin: fullName.split('/')[0] ?? '',
			private: false,
			archived: false,
		},
	}
}

/**
 * The composer a draft reopens with, read once when it opens. A snapshot this version can't read
 * opens blank, with the reason.
 */
export function fromDraftLaunch(task: Task): { seed: LaunchFormSeed; error: string | null } {
	const ticket = ticketFromTask(task)
	const parsed = parseDraftLaunch(task.draft_launch)
	if (!parsed.ok)
		return {
			seed: {
				text: '',
				target: null,
				hostId: null,
				settings: savedSettings(),
				ticket,
				taskSize: 'unknown',
				smallAutoAdvance: true,
				attachments: [],
			},
			error: parsed.error,
		}
	const { snapshot } = parsed
	return {
		seed: {
			text: snapshot.prompt,
			target: snapshot.target,
			hostId: snapshot.hostId || null,
			settings: snapshot.settings,
			ticket,
			taskSize: snapshot.taskSize,
			smallAutoAdvance: snapshot.smallAutoAdvance,
			vmScope: snapshot.vmScope ?? null,
			vmCpus: snapshot.vmCpus,
			vmMemoryGiB: snapshot.vmMemoryGiB,
			attachments: snapshot.attachments,
		},
		error: null,
	}
}

/** The composer as a draft snapshot. The inverse of `fromDraftLaunch` for everything but the ticket, which the row keeps. */
export function toDraftLaunch(
	state: VmSizing & {
		text: string
		target: DraftTarget
		hostId: string
		settings: ComposerSettings
		taskSize: TaskSize
		smallAutoAdvance: boolean
		/** Absent or null: follow the task size. */
		vmScope?: VmScope | null
		attachments: readonly AttachmentMetadata[]
	},
): DraftLaunch {
	return {
		version: state.vmCpus !== undefined || state.vmMemoryGiB !== undefined ? 2 : 1,
		prompt: state.text,
		attachments: [...state.attachments],
		target: state.target,
		hostId: state.hostId,
		settings: { ...state.settings },
		taskSize: state.taskSize,
		smallAutoAdvance: state.smallAutoAdvance,
		vmScope: state.vmScope ?? undefined,
		vmCpus: state.vmCpus,
		vmMemoryGiB: state.vmMemoryGiB,
	}
}

/** A picked target as a draft stores it: by id, without the name it shows with. */
export function draftTarget(target: { kind: 'project'; projectId: string } | { kind: 'directory'; path: string }) {
	return target.kind === 'project'
		? ({ kind: 'project', projectId: target.projectId } as const)
		: ({ kind: 'directory', path: target.path } as const)
}

/**
 * What `tasks.saveDraft` stores for a draft: its snapshot, its column, and the task fields a launch
 * would write (name, slug, ticket, workflow), so the card reads like the ticket it becomes.
 */
export function draftSaveInput(args: {
	taskId: string
	snapshot: DraftLaunch
	ticket: Ticket | null
	status: TaskStatus
}): SaveDraftInput {
	const { taskId, snapshot, ticket } = args
	const name = ticket?.name ?? draftTitle(snapshot.prompt)
	const worktreeTiming: WorktreeTiming = snapshot.target.kind === 'project' ? 'now' : 'never'
	const workflow = taskSizeWorkflow(snapshot.taskSize, snapshot.smallAutoAdvance)
	const repository = ticket?.githubRepository
	const flags = projectTaskAutoAdvanceFlags(workflow, worktreeTiming)
	return {
		id: taskId,
		name,
		slug: ticket?.slug ?? slugify(name, taskId.slice(-4)),
		defaultWorkingDirectory: snapshot.target.kind === 'directory' ? snapshot.target.path : null,
		ticketId: ticket?.ticketId ?? null,
		ticketDescription: null,
		ticketProvider: ticket?.provider ?? null,
		githubConnectionId: repository?.connectionId ?? null,
		ticketRepositoryId: repository?.repositoryId ?? null,
		ticketRepositoryFullName: repository?.fullName ?? null,
		workflowType: workflow.workflowType,
		worktreeTiming,
		autoAdvanceQuestionsToResearch: flags.autoAdvanceQuestionsToResearch,
		autoAdvanceResearchToDesign: flags.autoAdvanceResearchToDesign,
		autoAdvancePlanToWorktree: flags.autoAdvancePlanToWorktree,
		autoAdvanceWorktreeToImplementation: flags.autoAdvanceWorktreeToImplementation,
		autoAdvanceImplementationToPr: flags.autoAdvanceImplementationToPr,
		status: args.status,
		draftLaunch: snapshot,
	}
}

/**
 * `startTask`'s input from a snapshot: the one conversion both the new-task composer and a draft's
 * Start use, so a draft launches exactly what it shows. Without a status, a new task starts in
 * progress and a draft keeps its column.
 */
export function launchInput(args: {
	ids: { taskId: string; sessionId: string; eventId: string }
	target: LoadedTarget
	snapshot: DraftLaunch
	ticket: Ticket | null
	status?: TaskStatus
	/** The account picked in the composer. A draft's snapshot doesn't keep one, so its Start uses the project's or your default. */
	githubAccount?: StartTaskInput['githubAccount']
}): StartTaskInput {
	const { snapshot, target } = args
	const vmScope = snapshot.vmScope ?? defaultVmScope(snapshot.taskSize)
	// A saved draft's project may have switched away from VM since it was saved.
	const ownVm = target.kind === 'project' && target.project.sandbox === 'vm' && vmScope === 'task'
	const input: StartTaskInput = {
		ids: args.ids,
		target,
		hostId: snapshot.hostId,
		draft: snapshot.prompt,
		ticket: args.ticket,
		attachments: snapshot.attachments,
		settings: snapshot.settings,
		workflow: taskSizeWorkflow(snapshot.taskSize, snapshot.smallAutoAdvance),
		directImplementation: snapshot.taskSize === 'small',
		vmScope,
		vmCpus: ownVm ? snapshot.vmCpus : undefined,
		vmMemoryGiB: ownVm ? snapshot.vmMemoryGiB : undefined,
	}
	if (args.status) input.status = args.status
	if (args.githubAccount) input.githubAccount = args.githubAccount
	return input
}

/**
 * Starts a saved draft as it was saved: the draft's id is the task's, so the server promotes the
 * row in place. Throws when the snapshot can't be read or its project isn't the one given.
 */
export function toStartInput(
	task: Task,
	project: Extract<LoadedTarget, { kind: 'project' }>['project'] | undefined,
	ids: { sessionId: string; eventId: string },
): StartTaskInput {
	const parsed = parseDraftLaunch(task.draft_launch)
	if (!parsed.ok) throw new Error(parsed.error)
	const { snapshot } = parsed
	let target: LoadedTarget
	if (snapshot.target.kind === 'directory') target = snapshot.target
	else if (project?.id === snapshot.target.projectId) target = { kind: 'project', project }
	else throw new Error("This draft's project isn't available")
	return launchInput({ ids: { taskId: task.id, ...ids }, target, snapshot, ticket: ticketFromTask(task) })
}

/**
 * Everything a draft snapshots, in one place. A new task (`seed` null) starts from this device's
 * preferences and keeps its text and size picks on the device, as it always has; a draft starts
 * from its snapshot and keeps edits in the form, since its row is the source of truth.
 */
export function useLaunchForm({
	seed,
	textKey,
	hostId: requestedHostId,
	uploads,
}: {
	seed: LaunchFormSeed | null
	/** Where unsent text persists on this device when there's no draft seed. */
	textKey: string
	/** A host to start on, such as the one the offline notice offers. */
	hostId?: string
	/** The task id uploads go under, and whether that task has already launched. */
	uploads: { taskId: string; existing: boolean }
}) {
	const [storedText, setStoredText] = useDraft(textKey)
	const [storedSize, setStoredSize] = useTaskSize()
	const [storedSmallAutoAdvance, setStoredSmallAutoAdvance] = useSmallTaskAutoAdvance()
	const [draftText, setDraftText] = useState(seed?.text ?? '')
	const [draftSize, setDraftSize] = useState<TaskSize>(seed?.taskSize ?? 'unknown')
	const [draftSmallAutoAdvance, setDraftSmallAutoAdvance] = useState(seed?.smallAutoAdvance ?? true)
	const [target, setTarget] = useState<DraftTarget | null>(seed?.target ?? null)
	const [hostId, setHostId] = useState<string | null>(seed?.hostId ?? requestedHostId ?? null)
	const [settings, setSettings] = useState<ComposerSettings>(() => seed?.settings ?? savedSettings())
	const [ticket, setTicket] = useState<Ticket | null>(seed?.ticket ?? null)
	const [vmScope, setVmScope] = useState<VmScope | null>(seed?.vmScope ?? null)
	const [vmSizing, setVmSizing] = useState<VmSizing>({ vmCpus: seed?.vmCpus, vmMemoryGiB: seed?.vmMemoryGiB })
	const attachments = useAttachments(uploads.taskId, uploads.existing, seed?.attachments)
	const persisted = seed === null
	return {
		text: persisted ? storedText : draftText,
		setText: persisted ? setStoredText : setDraftText,
		target,
		setTarget,
		hostId,
		setHostId,
		settings,
		setSettings,
		ticket,
		setTicket,
		taskSize: persisted ? storedSize : draftSize,
		setTaskSize: persisted ? setStoredSize : setDraftSize,
		smallAutoAdvance: persisted ? storedSmallAutoAdvance : draftSmallAutoAdvance,
		setSmallAutoAdvance: persisted ? setStoredSmallAutoAdvance : setDraftSmallAutoAdvance,
		vmScope,
		setVmScope,
		vmSizing,
		setVmSizing,
		attachments,
	}
}

export type LaunchForm = ReturnType<typeof useLaunchForm>
