import { taskUserSettingsSelectSchema } from '@devflow/db/tables/task-user-settings'
import { type CollectionHealthTracker, createBrowserElectricCollection, type SyncVersion } from '@devflow/sync'

import { VITE_PUBLIC_SYNC_ORIGIN } from '@/collections/config'
import { logger } from '@/lib/logger'

const taskUserSettingsCollectionBuilder = createBrowserElectricCollection({
	schema: taskUserSettingsSelectSchema,
	routePath: '/task-user-settings',
	collectionName: 'taskUserSettings',
})

export const createTaskUserSettingsCollection = taskUserSettingsCollectionBuilder.create

export type TaskUserSettingsCollection = ReturnType<typeof createTaskUserSettingsCollection>

export const getTaskUserSettingsCollection = (
	userId: string | null,
	organizationId: string | null,
	tokenFetcher: () => Promise<string>,
	isLoading: boolean,
	tracker: CollectionHealthTracker,
	syncVersion: SyncVersion = 2,
) =>
	taskUserSettingsCollectionBuilder.get(
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
