import { providerLoginRequestSelectSchema } from '@devflow/db/tables/provider-login-requests'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const builder = createBrowserQueryCollection({
	collectionName: 'providerLoginRequests',
	rowSchema: providerLoginRequestSelectSchema,
	procedure: (client) => (client as ApiClient).sync.v2.providerLoginRequests,
	bigIntFields: ['expires_at', 'created_at', 'updated_at'],
})
export const createQueryProviderLoginRequestsCollection = builder.create
export type QueryProviderLoginRequestsCollection = ReturnType<typeof createQueryProviderLoginRequestsCollection>
export const getQueryProviderLoginRequestsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	builder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})
export const destroyQueryProviderLoginRequestsCollection = builder.destroy
