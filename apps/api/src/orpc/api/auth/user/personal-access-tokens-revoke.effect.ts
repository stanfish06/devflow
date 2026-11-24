import { Effect } from 'effect'

import { revokePersonalAccessToken } from '../../../../auth/personal-access-tokens'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'

export const revokePersonalAccessTokenProcedure =
	effectOrpcBaseOrganizationRequired.auth.user.personalAccessTokens.revoke.effect(function* ({
		input,
		context,
		errors,
	}) {
		yield* revokePersonalAccessToken({
			userId: context.auth.userId,
			workosOrganizationId: context.auth.workosOrganizationId,
			id: input.id,
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchTags({
				PersonalAccessTokenNotFoundError: () =>
					Effect.fail(errors.NOT_FOUND({ data: { message: 'Personal access token not found' } })),
				PersonalAccessTokenStoreError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			}),
		)

		return { success: true }
	})
