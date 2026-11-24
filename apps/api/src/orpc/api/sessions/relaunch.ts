import { sessions } from '@devflow/db/tables/sessions'
import { and, eq } from 'drizzle-orm'
import { Clock, Effect } from 'effect'

import { getTxId } from '../../../db/get-tx-id'
import { mapPostgresErrorToResponse } from '../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../effects/services/postgres/postgres-db.service'
import {
	getSessionPromptingAccess,
	hasRequiredSessionAccess,
	SessionAccessControl,
} from '../../../lib/session-multiplayer-prompting-auth'
import { effectOrpcBaseOrganizationRequired } from '../../effect-base'
import { ORPCBadRequestError, ORPCForbiddenError, ORPCNotFoundError } from '../../effect-errors'

/** Retry a failed launch before an agent conversation exists, preserving its original prompt and events. */
export const relaunchSessionProcedure = effectOrpcBaseOrganizationRequired.sessions.relaunch.effect(function* ({
	input,
	context,
	errors,
}) {
	const postgres = yield* PostgresDb
	const nowMillis = yield* Clock.currentTimeMillis
	const { sessionId } = input
	const { userId, organizationId } = context.auth
	const observabilityContext = { sessionId, userId, origin: 'card_retry' }

	return yield* postgres
		.transaction((tx) =>
			Effect.gen(function* () {
				// Serialize retries so a second click cannot requeue an already queued session.
				const [session] = yield* tx.query(
					tx.client
						.select({ status: sessions.status, coding_agent_session_id: sessions.coding_agent_session_id })
						.from(sessions)
						.where(and(eq(sessions.id, sessionId), eq(sessions.organization_id, organizationId)))
						.limit(1)
						.for('no key update'),
				)
				if (!session) return yield* new ORPCNotFoundError()
				if (
					(session.status !== 'failed' && session.status !== 'lost') ||
					session.coding_agent_session_id !== null
				) {
					return yield* new ORPCBadRequestError()
				}

				const { accessLevel } = yield* getSessionPromptingAccess(
					tx,
					{ organizationId, sessionId, actorUserId: userId },
					nowMillis,
				)
				if (!hasRequiredSessionAccess(accessLevel, SessionAccessControl.prompt)) {
					return yield* new ORPCForbiddenError()
				}

				// The unchanged daemon launch path consumes ready_for_launch; no new message is needed.
				yield* tx.query(
					tx.client
						.update(sessions)
						.set({
							status: 'ready_for_launch',
							error_message: null,
							error_reason: null,
							last_activity_at: BigInt(nowMillis),
						})
						.where(eq(sessions.id, sessionId)),
				)
				const transactionId = yield* tx.run(() => getTxId(tx.client))
				yield* Effect.logInfo('sessions.relaunch completed').pipe(Effect.annotateLogs(observabilityContext))
				return { success: true, transactionId }
			}),
		)
		.pipe(
			Effect.tapError((error) =>
				Effect.logError('sessions.relaunch failed', error).pipe(Effect.annotateLogs(observabilityContext)),
			),
			Effect.catchTag('SessionDoesNotExistError', () => Effect.fail(new ORPCNotFoundError())),
			Effect.catchTags({
				PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors),
				PostgresDbTransactionError: (error) => mapPostgresErrorToResponse(error, errors),
			}),
			Effect.withSpan('sessions.relaunch', { attributes: { session_id: sessionId, origin: 'card_retry' } }),
		)
})
