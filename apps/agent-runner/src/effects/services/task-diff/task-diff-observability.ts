import { Effect } from 'effect'

export const reportTaskDiffError = (
	error: unknown,
	operation: string,
	attributes: Readonly<Record<string, string | number | boolean>> = {},
) => Effect.logError('Task diff operation failed', error).pipe(Effect.annotateLogs({ operation, ...attributes }))
