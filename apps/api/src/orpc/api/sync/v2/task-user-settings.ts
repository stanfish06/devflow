import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { and, getTableColumns } from 'drizzle-orm'

import { buildTaskUserSettingsSyncWhereV2 } from '../../../../db/sync-auth'
import {
	buildDrizzleOrderFromSorts,
	buildDrizzleWhereFromExpression,
	SyncFilterError,
} from '../../../../db/sync-filters'
import { logger } from '../../../../logger'
import { apiBaseSyncV2 } from '../../../base'

export const syncV2TaskUserSettingsProcedure = apiBaseSyncV2.sync.v2.taskUserSettings.handler(
	async ({ input, context, errors }) => {
		const { where, sorts, limit, offset } = input
		const { organizationId, userId } = context.auth
		const { db } = context.services

		try {
			const authWhere = buildTaskUserSettingsSyncWhereV2({ organizationId, userId })
			const clientWhere = buildDrizzleWhereFromExpression(
				getTableColumns(taskUserSettings),
				where,
				'task_user_settings',
			)
			const orderBy = buildDrizzleOrderFromSorts(getTableColumns(taskUserSettings), sorts, 'task_user_settings')

			let query = db.select().from(taskUserSettings).where(and(authWhere, clientWhere)).$dynamic()

			if (orderBy.length > 0) query = query.orderBy(...orderBy)
			query = query.limit(limit ?? 10000)
			if (offset !== undefined) query = query.offset(offset)

			const rows = await query
			return { rows }
		} catch (error) {
			if (error instanceof SyncFilterError) {
				throw errors.BAD_REQUEST({ data: { message: error.message } })
			}
			logger.error(error, {
				tags: { error_type: 'sync_query' },
				extra: { table: 'task_user_settings_v2', hasWhere: !!where },
			})
			throw error
		}
	},
)
