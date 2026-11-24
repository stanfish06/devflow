import { Effect } from 'effect'
import { uuidv7 } from 'uuidv7'

import { GitHubService } from '../../../effects/services/github/github.service'
import {
	TaskLaunchConflict,
	TaskLaunchForbidden,
	TaskLaunchUnavailable,
} from '../../../effects/services/task-launch/task-launch.errors'
import { TaskLaunchService } from '../../../effects/services/task-launch/task-launch.service'
import type { PreparedTicketArtifactBundle } from '../../../effects/services/task-launch/task-launch.types'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { TASK_ID_IN_USE_MESSAGE, slugInTaskUsedMessage } from './task-conflict-messages'

function sanitizeArtifactFileStem(stem: string): string {
	return stem.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
}

export const launchTaskDraftProcedure = effectOrpcBaseOrganizationRequired.tasks.launchDraft.effect(function* ({
	input,
	context,
	errors,
}) {
	const taskLaunch = yield* TaskLaunchService
	let importedTicket: PreparedTicketArtifactBundle | undefined
	const importAttemptId = uuidv7()
	const { ticketProvider, ticketId } = input

	if (ticketProvider === 'github' && ticketId) {
		const { githubConnectionId, ticketRepositoryId } = input
		if (githubConnectionId && ticketRepositoryId) {
			const github = yield* GitHubService
			const githubBundle = yield* github
				.prepareIssueImport({
					organizationId: context.auth.organizationId,
					taskId: input.draftId,
					importAttemptId,
					connectionId: githubConnectionId,
					repositoryId: ticketRepositoryId,
					issueInput: ticketId,
				})
				.pipe(Effect.mapError(() => errors.SERVICE_UNAVAILABLE()))
			const { identity, ticket, images } = githubBundle
			importedTicket = {
				label: `${identity.repositoryFullName}#${identity.issueNumber}`,
				fileName: `${sanitizeArtifactFileStem(`${identity.repositoryFullName}-${identity.issueNumber}`)}.md`,
				content: ticket.content,
				contentHash: ticket.contentHash,
				images,
			}
		}
	}

	return yield* taskLaunch
		.launchTaskDraft({
			...input,
			importedTicket,
			organizationId: context.auth.organizationId,
			userId: context.auth.userId,
		})
		.pipe(
			Effect.catchTags({
				TaskLaunchConflict: (error: TaskLaunchConflict) =>
					Effect.fail(
						errors.TASK_LAUNCH_CONFLICT({
							data: {
								draftId: error.draftId,
								reason: error.reason,
								message:
									error.reason === 'slug-in-use'
										? slugInTaskUsedMessage(input.slug)
										: TASK_ID_IN_USE_MESSAGE,
							},
						}),
					),
				TaskLaunchForbidden: (_error: TaskLaunchForbidden) => Effect.fail(errors.FORBIDDEN()),
				TaskLaunchUnavailable: (_error: TaskLaunchUnavailable) => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			}),
		)
})
