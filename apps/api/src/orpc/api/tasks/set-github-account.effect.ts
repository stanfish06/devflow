import { Effect } from 'effect'

import { setTaskGithubAccount } from '../../../effects/github-accounts/account-choice'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'

/** Choose the GitHub account the caller's agents act as in a task, or null for the host's gh login. */
export const setTaskGithubAccountProcedure = effectOrpcBaseOrganizationRequired.tasks.setGithubAccount.effect(
	function* ({ input, context, errors }) {
		return yield* setTaskGithubAccount({
			actor: { organizationId: context.auth.organizationId, userId: context.auth.userId },
			taskId: input.taskId,
			accountId: input.accountId,
		}).pipe(
			Effect.catchTags({
				TaskNotFoundError: () => Effect.fail(errors.NOT_FOUND({ data: { message: 'Task not found' } })),
				GithubAccountNotFound: () =>
					Effect.fail(errors.NOT_FOUND({ data: { message: 'GitHub account not found' } })),
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
		)
	},
)
