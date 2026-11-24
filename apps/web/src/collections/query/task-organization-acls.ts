import { taskOrganizationAclSelectSchema } from '@devflow/db/tables/task-organization-acl'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const queryTaskOrganizationAclsCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'taskOrganizationAcls',
	rowSchema: taskOrganizationAclSelectSchema,
	procedure: (apiClient, syncVersion) => {
		const client = apiClient as ApiClient
		return syncVersion === 2 ? client.sync.v2.taskOrganizationAcls : client.sync.taskOrganizationAcls
	},
	bigIntFields: ['created_at'],
})

export const createQueryTaskOrganizationAclsCollection = queryTaskOrganizationAclsCollectionBuilder.create

export type QueryTaskOrganizationAclsCollection = ReturnType<typeof createQueryTaskOrganizationAclsCollection>

export const getQueryTaskOrganizationAclsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	queryTaskOrganizationAclsCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})

export const destroyQueryTaskOrganizationAclsCollection = (
	userId: string | null,
	organizationId: string | null,
	syncVersion: SyncVersion = 2,
) => queryTaskOrganizationAclsCollectionBuilder.destroy(userId, organizationId, syncVersion)
