import { Effect, Redacted } from 'effect'

import { createPersonalAccessToken } from '../../../../auth/personal-access-tokens'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'

export const createPersonalAccessTokenProcedure =
	effectOrpcBaseOrganizationRequired.auth.user.personalAccessTokens.create.effect(function* ({
		input,
		context,
		errors,
	}) {
		const result = yield* createPersonalAccessToken({
			userId: context.auth.userId,
			workosOrganizationId: context.auth.workosOrganizationId,
			name: input.name,
			expiresInDays: input.expiresInDays,
		}).pipe(
			Effect.tapError(Effect.logError),
			Effect.catchTags({
				PersonalAccessTokenStoreError: () => Effect.fail(errors.SERVICE_UNAVAILABLE()),
			}),
		)

		return { token: result.token, value: Redacted.value(result.value) }
	})
