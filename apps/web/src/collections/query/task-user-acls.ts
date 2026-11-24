import { taskUserAclSelectSchema } from '@devflow/db/tables/task-user-acl'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const queryTaskUserAclsCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'taskUserAcls',
	rowSchema: taskUserAclSelectSchema,
	procedure: (apiClient, syncVersion) => {
		const client = apiClient as ApiClient
		return syncVersion === 2 ? client.sync.v2.taskUserAcls : client.sync.taskUserAcls
	},
	bigIntFields: ['created_at'],
})

export const createQueryTaskUserAclsCollection = queryTaskUserAclsCollectionBuilder.create

export type QueryTaskUserAclsCollection = ReturnType<typeof createQueryTaskUserAclsCollection>

export const getQueryTaskUserAclsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	queryTaskUserAclsCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})

export const destroyQueryTaskUserAclsCollection = (
	userId: string | null,
	organizationId: string | null,
	syncVersion: SyncVersion = 2,
) => queryTaskUserAclsCollectionBuilder.destroy(userId, organizationId, syncVersion)
