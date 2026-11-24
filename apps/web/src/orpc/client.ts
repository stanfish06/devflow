import { ApiContract } from '@devflow/api-contract/contract-router'
import { ORPCError, createORPCClient } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import type { JsonifiedClient } from '@orpc/openapi-client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { useMemo } from 'react'
import { toast } from 'sonner'

import { useAuth } from '@/integrations/devflow/local-authkit'
import { logger } from '@/lib/logger'

/** Type alias for the devflow API client */
export type ApiClient = JsonifiedClient<ContractRouterClient<typeof ApiContract>>

/**
 * Default API origin for local development
 */
const DEFAULT_API_ORIGIN = 'http://localhost:8700'

export const appApiOrigin = import.meta.env.VITE_PUBLIC_DEVFLOW_API_ORIGIN || DEFAULT_API_ORIGIN

function getDefinedErrorDataMessage(error: { data?: unknown; message?: string }): string | undefined {
	if (!error.data || typeof error.data !== 'object') return undefined
	const message = (error.data as { message?: unknown }).message
	if (typeof message !== 'string' || message.trim().length === 0) return undefined
	if (message === error.message) return undefined
	return message
}

interface ApiErrorOptions {
	context?: { silent?: boolean }
}

export function handleApiError(
	error: ORPCError<string, unknown>,
	options: ApiErrorOptions | undefined,
): void {
	if (options?.context?.silent) return

	logger.error(`devflow API oRPC Client Error:`, error)
	const dataMessage = getDefinedErrorDataMessage(error)

	switch (error.code) {
		case 'UNAUTHORIZED':
			// A 401 also answers requests sent before the local session loads; the auth provider retries.
			break

		case 'TASK_SLUG_CONFLICT':
		case 'TASK_LAUNCH_CONFLICT':
			// Only the task composers call tasks.create and tasks.launchDraft, and they show these messages themselves.
			break

		case 'FORBIDDEN':
			toast.error("You don't have permission to perform this action.", {
				description: dataMessage,
			})
			break

		case 'INPUT_VALIDATION_FAILED': {
			const validationMessage = error.message || 'Please check your input and try again.'
			toast.error(`Validation error: ${validationMessage}`)
			break
		}

		case 'NETWORK_ERROR':
			toast.error('Connection issue. Please check your internet connection.')
			break

		case 'SERVER_ERROR':
		case 'INTERNAL_SERVER_ERROR':
			toast.error('Something went wrong on our end. Please try again later.')
			break

		default:
			toast.error(error.message || 'An unexpected error occurred. Please try again.', {
				description: dataMessage,
			})
	}
}

interface ApiInterceptorOptions extends ApiErrorOptions {
	next: () => Promise<unknown>
}

export function createApiErrorInterceptor(): (options: ApiInterceptorOptions) => Promise<unknown> {
	return async (options) => {
		try {
			return await options.next()
		} catch (error) {
			if (options.context?.silent || !(error instanceof ORPCError) || !error.defined) throw error
			handleApiError(error, options)
			throw error
		}
	}
}

/**
 * Hook that creates oRPC clients for the devflow API.
 *
 * Returns:
 * - `client` - Raw oRPC client for direct API calls: `client.sessions.update(input)`
 * - `queryClient` - TanStack Query wrapped client for hooks: `queryClient.sessions.update.queryOptions()`
 *
 * IMPORTANT! This hook MUST be used under the `<AuthProvider>` since it uses useAuth
 *
 * @example
 * ```tsx
 * const { client, queryClient } = useApi()
 *
 * // Direct API call (for optimistic actions)
 * await client.sessions.update({ sessionId, title })
 *
 * // TanStack Query hook
 * const { data } = useQuery(queryClient.auth.user.organizations.list.queryOptions({}))
 * ```
 */
export function useApi() {
	const { getAccessToken, user, organizationId } = useAuth()

	const { client, queryClient } = useMemo(() => {
		const link = new OpenAPILink(ApiContract, {
			url: `${appApiOrigin}/rpc/api/v1`,
			headers: async () => {
				if (!user) return {}
				const accessToken = await getAccessToken()
				return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
			},
			interceptors: [createApiErrorInterceptor()],
		})

		// Raw client for direct API calls
		const client: JsonifiedClient<ContractRouterClient<typeof ApiContract>> = createORPCClient(link)

		// TanStack Query wrapped client for hooks
		const queryClient = createTanstackQueryUtils(client)

		return { client, queryClient }
	}, [getAccessToken, user, user?.id, organizationId])

	const authScope = { userId: user?.id ?? null, organizationId: organizationId ?? null }

	return { client, queryClient, authScope }
}
