import { onlineHostSelectSchema } from '@devflow/db/tables/online-hosts'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import { BTreeIndex } from '@tanstack/db'
import type { QueryClient } from '@tanstack/query-core'
import type z from 'zod/v4'

import { getOnlineHostKey } from '@/collections/online-host-key'
import type { ApiClient } from '@/orpc/client'

export type OnlineHostRow = z.output<typeof onlineHostSelectSchema>

const queryOnlineHostsCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'onlineHosts',
	rowSchema: onlineHostSelectSchema,
	procedure: (apiClient, syncVersion) => {
		const client = apiClient as ApiClient
		return syncVersion === 2 ? client.sync.v2.onlineHosts : client.sync.onlineHosts
	},
	bigIntFields: ['last_seen'],
	indexes: [{ field: (row) => row.host_id, name: 'host_id', indexType: BTreeIndex }],
	getKey: getOnlineHostKey,
})

export const createQueryOnlineHostsCollection = queryOnlineHostsCollectionBuilder.create

export type QueryOnlineHostsCollection = ReturnType<typeof createQueryOnlineHostsCollection>

export const getQueryOnlineHostsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	queryOnlineHostsCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})

export const destroyQueryOnlineHostsCollection = (
	userId: string | null,
	organizationId: string | null,
	syncVersion: SyncVersion = 2,
) => queryOnlineHostsCollectionBuilder.destroy(userId, organizationId, syncVersion)
