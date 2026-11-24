import { taskUserSettingsSelectSchema } from '@devflow/db/tables/task-user-settings'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const queryTaskUserSettingsCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'taskUserSettings',
	rowSchema: taskUserSettingsSelectSchema,
	procedure: (apiClient, syncVersion) => {
		const client = apiClient as ApiClient
		return syncVersion === 2 ? client.sync.v2.taskUserSettings : client.sync.taskUserSettings
	},
	bigIntFields: ['created_at', 'updated_at', 'workspace_materialized_at'],
})

export const createQueryTaskUserSettingsCollection = queryTaskUserSettingsCollectionBuilder.create

export type QueryTaskUserSettingsCollection = ReturnType<typeof createQueryTaskUserSettingsCollection>

export const getQueryTaskUserSettingsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
	syncVersion: SyncVersion = 2,
) =>
	queryTaskUserSettingsCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion,
	})

export const destroyQueryTaskUserSettingsCollection = (
	userId: string | null,
	organizationId: string | null,
	syncVersion: SyncVersion = 2,
) => queryTaskUserSettingsCollectionBuilder.destroy(userId, organizationId, syncVersion)
