import { providerLoginRequestSelectSchema } from '@devflow/db/tables/provider-login-requests'
import { type CollectionHealthTracker, createBrowserElectricCollection, type SyncVersion } from '@devflow/sync'

import { VITE_PUBLIC_SYNC_ORIGIN } from '@/collections/config'
import { logger } from '@/lib/logger'

const builder = createBrowserElectricCollection({
	schema: providerLoginRequestSelectSchema,
	routePath: '/provider-login-requests',
	collectionName: 'providerLoginRequests',
})
export const createProviderLoginRequestsCollection = builder.create
export type ProviderLoginRequestsCollection = ReturnType<typeof createProviderLoginRequestsCollection>
export const getProviderLoginRequestsCollection = (
	userId: string | null,
	organizationId: string | null,
	tokenFetcher: () => Promise<string>,
	isLoading: boolean,
	tracker: CollectionHealthTracker,
	syncVersion: SyncVersion = 2,
) =>
	builder.get(
		userId,
		organizationId,
		{
			syncOrigin: VITE_PUBLIC_SYNC_ORIGIN,
			tokenFetcher,
			shouldRetryOnFailure: !isLoading,
			tracker,
			syncVersion,
			logger,
		},
		isLoading,
	)
