import { taskWorkspaceSetupForHostSelectSchema } from '@devflow/db/tables/task-workspace-setup-for-host'
import { type CollectionHealthTracker, createBrowserQueryCollection, type SyncVersion } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const builder = createBrowserQueryCollection({
	collectionName: 'workspaceSetup',
	rowSchema: taskWorkspaceSetupForHostSelectSchema,
	procedure: (client) => (client as ApiClient).sync.v2.taskWorkspaceSetupForHost,
	bigIntFields: ['created_at', 'updated_at'],
})
export const createQueryTaskWorkspaceSetupForHostCollection = builder.create
export type QueryTaskWorkspaceSetupForHostCollection = ReturnType<typeof createQueryTaskWorkspaceSetupForHostCollection>
export const getQueryTaskWorkspaceSetupForHostCollection = (
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
export const destroyQueryTaskWorkspaceSetupForHostCollection = builder.destroy
