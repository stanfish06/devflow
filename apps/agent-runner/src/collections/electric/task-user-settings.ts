import { taskUserSettingsSelectSchema } from '@devflow/db/tables/task-user-settings'
import { createElectricCollection } from '@devflow/sync'

import logger from '@/logger'

export type TaskUserSettingsCollection = ReturnType<typeof createTaskUserSettingsCollection>

/**
 * The daemon user's own per-task settings (never a teammate's): where the daemon learns that the
 * GitHub account for one of its tasks changed while a session of it is running.
 */
export function createTaskUserSettingsCollection(syncOrigin: string, token: string) {
	return createElectricCollection({
		schema: taskUserSettingsSelectSchema,
		collectionName: 'taskUserSettings',
		syncOrigin,
		syncVersion: 2,
		routePath: '/daemon/task-user-settings',
		headers: { 'x-daemon-authorization': token },
		shouldRetryOnFailure: true,
		logger,
		getKey: (item) => item.id,
	})
}
