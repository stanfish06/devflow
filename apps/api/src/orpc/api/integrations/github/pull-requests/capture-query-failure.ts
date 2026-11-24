import { Effect } from 'effect'

// `PostgresDb.query` only logs, so without this the narrowed failure reaches nobody.
export const captureQueryFailure = (operation: string, organizationId: string) => (cause: unknown) =>
	Effect.logError('GitHub PR panel database read failed', cause).pipe(
		Effect.annotateLogs({ operation, organization_id: organizationId }),
	)
