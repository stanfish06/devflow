import type { SimpleAuthContext } from '../app-config'
import { logger } from './logger'

export interface ElectricRequestContext {
	/** The auth context (userId, organizationId, hostId) */
	authContext: SimpleAuthContext
	/** The route path (e.g., '/v1/sessions', '/v1/approvals') */
	routePath: string
	/** The table being queried */
	tableName: string
	/** The WHERE fragment sent to Electric */
	whereFragment?: string
	/** The params array sent to Electric */
	whereParams?: unknown[]
	/** The full Electric URL (will be logged with secrets redacted) */
	electricUrl: URL
}

/**
 * Check if a status code is an error we want to capture
 * (4XX except 409, or 5XX)
 *
 * 409 is excluded because Electric uses it for shape changes (expected behavior)
 */
export function headerIndicatesCapturableError(status: number): boolean {
	const is4xx = status >= 400 && status < 500
	const is5xx = status >= 500 && status < 600
	return (is4xx && status !== 409) || is5xx
}

/**
 * Redact sensitive params from the Electric URL for logging
 */
export function redactUrl(url: URL): string {
	const redacted = new URL(url.toString())
	if (redacted.searchParams.has('secret')) {
		redacted.searchParams.set('secret', '[REDACTED]')
	}
	return redacted.toString()
}

/**
 * Logs an Electric error response with its request and auth context.
 *
 * @param status - HTTP status code
 * @param statusText - HTTP status text
 * @param responseBody - The pre-read response body string
 * @param context - Request context for logging/tracing
 */
export async function handleElectricError(
	status: number,
	statusText: string,
	responseBody: string,
	context: ElectricRequestContext,
): Promise<void> {
	const errorContext = {
		status,
		statusText,
		routePath: context.routePath,
		tableName: context.tableName,
		whereFragment: context.whereFragment,
		whereParams: context.whereParams,
		electricUrl: redactUrl(context.electricUrl),
		responseBody,
		userId: context.authContext.userId,
		organizationId: context.authContext.organizationId,
		hostId: context.authContext.hostId,
	}

	logger.error('Electric proxy error response', errorContext)
}
