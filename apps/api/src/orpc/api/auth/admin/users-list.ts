import { userSettings } from '@devflow/db/tables/user-settings'
import { eq } from 'drizzle-orm'

import { apiBaseForOrganizationAdmin } from '../../../base'

export const listAdminUsersProcedure = apiBaseForOrganizationAdmin.auth.admin.users.list.handler(
	async ({ context }) => {
		const {
			auth,
			services: { db, directory },
		} = context

		const settingsRows = await db
			.select({
				user_id: userSettings.user_id,
				metrics_advanced_enabled: userSettings.metrics_advanced_enabled,
			})
			.from(userSettings)
			.where(eq(userSettings.organization_id, auth.organizationId))
		const metricsAdvancedByUserId = new Map(settingsRows.map((row) => [row.user_id, row.metrics_advanced_enabled]))

		const memberships = directory.listMemberships({
			organizationId: auth.workosOrganizationId,
			statuses: ['active', 'inactive'],
		})

		return {
			users: memberships.flatMap((membership) => {
				const user = directory.getUser(membership.userId)
				if (!user) return []
				return [
					{
						id: user.id,
						email: user.email,
						firstName: user.firstName ?? undefined,
						lastName: user.lastName ?? undefined,
						profilePictureUrl: user.profilePictureUrl ?? undefined,
						role: membership.role,
						membershipId: membership.id,
						status: membership.status,
						createdAt: user.createdAt,
						// No settings row means the column default (TRUE) applies.
						metricsAdvancedEnabled: metricsAdvancedByUserId.get(user.id) ?? true,
					},
				]
			}),
		}
	},
)
