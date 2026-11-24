import { queuedMessageSelectSchema } from '@devflow/db/tables/queued-messages'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import { BasicIndex } from '@tanstack/db'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const queryQueuedMessagesCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'queuedMessages',
	rowSchema: queuedMessageSelectSchema,
	procedure: (apiClient, syncVersion) => {
		const client = apiClient as ApiClient
		return syncVersion === 2 ? client.sync.v2.queuedMessages : client.sync.queuedMessages
	},
	bigIntFields: ['created_at', 'updated_at'],
	indexes: [{ field: (row) => row.session_id, name: 'session_id', indexType: BasicIndex }],
})

export const createQueryQueuedMessagesCollection = queryQueuedMessagesCollectionBuilder.create

export type QueryQueuedMessagesCollection = ReturnType<typeof createQueryQueuedMessagesCollection>

export const getQueryQueuedMessagesCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	queryQueuedMessagesCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})

export const destroyQueryQueuedMessagesCollection = (
	userId: string | null,
	organizationId: string | null,
	syncVersion: SyncVersion = 2,
) => queryQueuedMessagesCollectionBuilder.destroy(userId, organizationId, syncVersion)
