import { sql } from 'drizzle-orm'

import { apiBaseOrgRequired } from '../../base'
import { calculateDateRange, formatDate } from './utils'

export const mostSessionsProcedure = apiBaseOrgRequired.metrics.mostSessions.handler(async ({ context, input }) => {
	const { dbReadReplica } = context.services
	const { organizationId, workosOrganizationId } = context.auth
	const { directory } = context.services
	const offset = input.timezoneOffset ?? 0

	const { startDate, endDate, startTimestamp, endTimestamp } = calculateDateRange(input.range)

	const metricsResults = await dbReadReplica.execute<{
		user_id: string
		sessions_created: string
		sessions_continued: string
	}>(sql`
			SELECT
				resource_owner_user_id as user_id,
				COUNT(*) FILTER (WHERE created_by = resource_owner_user_id)::text as sessions_created,
				COUNT(*) FILTER (WHERE created_by != resource_owner_user_id)::text as sessions_continued
			FROM sessions
			WHERE organization_id = ${organizationId}
				AND created_at >= ${startTimestamp}
				AND created_at <= ${endTimestamp}
			GROUP BY resource_owner_user_id
			ORDER BY COUNT(*) DESC
		`)
	const organizationUsers = directory.listUsers({ organizationId: workosOrganizationId })

	// Create a map of user profiles for O(1) lookup
	const userProfileMap = new Map<string, { displayName: string; profilePictureUrl: string | undefined }>()

	for (const user of organizationUsers) {
		const displayName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email
		userProfileMap.set(user.id, {
			displayName,
			profilePictureUrl: user.profilePictureUrl ?? undefined,
		})
	}

	// Combine metrics with user profiles
	const data = (metricsResults as Array<{ user_id: string; sessions_created: string; sessions_continued: string }>)
		.map((row) => {
			const profile = userProfileMap.get(row.user_id)
			const sessionsCreated = Number.parseInt(row.sessions_created, 10)
			const sessionsContinued = Number.parseInt(row.sessions_continued, 10)

			return {
				userId: row.user_id,
				displayName: profile?.displayName ?? 'Unknown User',
				profilePictureUrl: profile?.profilePictureUrl,
				sessionsCreated,
				sessionsContinued,
				totalSessions: sessionsCreated + sessionsContinued,
			}
		})
		// Sort by total sessions descending (in case DB ordering changed)
		.sort((a, b) => b.totalSessions - a.totalSessions)

	return {
		data,
		startDate: formatDate(startDate, offset),
		endDate: formatDate(endDate, offset),
	}
})
