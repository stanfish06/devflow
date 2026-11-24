import { Effect } from 'effect'

import { listPersonalAccessTokens } from '../../../../auth/personal-access-tokens'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'

export const listPersonalAccessTokensProcedure =
	effectOrpcBaseOrganizationRequired.auth.user.personalAccessTokens.list.effect(function* ({ context, errors }) {
		const tokens = yield* listPersonalAccessTokens({
			userId: context.auth.userId,
			workosOrganizationId: context.auth.workosOrganizationId,
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchTags({
				PersonalAccessTokenStoreError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			}),
		)

		return { tokens: [...tokens] }
	})
