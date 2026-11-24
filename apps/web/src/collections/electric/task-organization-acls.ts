import { taskOrganizationAclSelectSchema } from '@devflow/db/tables/task-organization-acl'
import { type CollectionHealthTracker, createBrowserElectricCollection, type SyncVersion } from '@devflow/sync'

import { VITE_PUBLIC_SYNC_ORIGIN } from '@/collections/config'
import { logger } from '@/lib/logger'

const taskOrganizationAclsCollectionBuilder = createBrowserElectricCollection({
	schema: taskOrganizationAclSelectSchema,
	routePath: '/task-organization-acls',
	collectionName: 'taskOrganizationAcls',
})

export const createTaskOrganizationAclsCollection = taskOrganizationAclsCollectionBuilder.create

export type TaskOrganizationAclsCollection = ReturnType<typeof createTaskOrganizationAclsCollection>

export const getTaskOrganizationAclsCollection = (
	userId: string | null,
	organizationId: string | null,
	tokenFetcher: () => Promise<string>,
	isLoading: boolean,
	tracker: CollectionHealthTracker,
	syncVersion: SyncVersion = 2,
) =>
	taskOrganizationAclsCollectionBuilder.get(
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
