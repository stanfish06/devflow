import { providerLoginRequestSelectSchema } from '@devflow/db/tables/provider-login-requests'
import { createElectricCollection } from '@devflow/sync'

import logger from '@/logger'

export type ProviderLoginRequestsCollection = ReturnType<typeof createProviderLoginRequestsCollection>
export function createProviderLoginRequestsCollection(syncOrigin: string, token: string) {
	return createElectricCollection({
		schema: providerLoginRequestSelectSchema,
		collectionName: 'providerLoginRequests',
		syncOrigin,
		syncVersion: 2,
		routePath: '/daemon/provider-login-requests',
		headers: { 'x-daemon-authorization': token },
		shouldRetryOnFailure: true,
		logger,
		getKey: (item) => item.id,
	})
}
