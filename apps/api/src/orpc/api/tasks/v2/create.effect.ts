import { Effect } from 'effect'
import { uuidv7 } from 'uuidv7'

import { createTaskV2 } from '../../../../effects/project-workspace/create-task-v2'
import { GitHubService } from '../../../../effects/services/github/github.service'
import type { PreparedTicketArtifactBundle } from '../../../../effects/services/task-launch/task-launch.types'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'
import { GITHUB_ACCOUNT_NOT_FOUND } from '../task-conflict-messages'

function sanitizeArtifactFileStem(stem: string): string {
	return stem.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
}

export const createTaskV2Procedure = effectOrpcBaseOrganizationRequired.tasks.v2.create.effect(function* ({
	input,
	context,
	errors,
}) {
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
					taskId: input.taskId,
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

	return yield* createTaskV2({
		...input,
		actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
		importedTicket,
	}).pipe(
		Effect.catchTags({
			ProjectsV2Disabled: () => Effect.fail(errors.FORBIDDEN()),
			ProjectNotFound: (error) => Effect.fail(errors.PROJECT_NOT_FOUND({ data: { projectId: error.projectId } })),
			ProjectLocationInvalid: (error) =>
				Effect.fail(errors.LOCATION_MISSING({ data: { message: error.message } })),
			UnsupportedRecipeProfile: (error) =>
				Effect.fail(errors.UNSUPPORTED_RECIPE({ data: { message: error.message } })),
			ProjectPersistenceUnavailable: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			GithubAccountNotFound: () => Effect.fail(errors.NOT_FOUND({ data: { message: GITHUB_ACCOUNT_NOT_FOUND } })),
			RepositorySourcesRequired: (error) =>
				Effect.fail(
					errors.REPOSITORY_SOURCES_REQUIRED({
						data: {
							projectId: error.projectId,
							workspaceId: error.workspaceId,
							hostId: error.hostId,
							missingRepositoryIdentities: [...error.missingRepositoryIdentities],
						},
					}),
				),
			PostgresDbQueryError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			PostgresDbTransactionError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
		}),
	)
})
