import { artifacts } from '@devflow/db/tables/artifacts'
import { organizationSettings } from '@devflow/db/tables/organization-settings'
import { organizations } from '@devflow/db/tables/organizations'
import { eq } from 'drizzle-orm'

import { apiBasePublic } from '../../../base'

export const artifactInfoProcedure = apiBasePublic.public.artifacts.info.handler(async ({ context, input, errors }) => {
	const { db, directory } = context.services
	const [row] = await db
		.select({
			id: artifacts.id,
			organization_id: artifacts.organization_id,
			file_name: artifacts.file_name,
			workos_organization_id: organizations.workos_organization_id,
			organization_name: organizations.name,
		})
		.from(artifacts)
		.leftJoin(organizations, eq(organizations.id, artifacts.organization_id))
		.where(eq(artifacts.id, input.artifactId))
		.limit(1)

	if (!row) throw errors.NOT_FOUND()

	if (context.auth?.organizationId === row.organization_id) {
		return { exists: true, accessible: true }
	}

	// A member of the artifact's organization whose active organization differs is prompted to switch.
	if (
		context.auth?.userId &&
		row.workos_organization_id &&
		row.organization_name &&
		directory.isActiveMember(context.auth.userId, row.workos_organization_id)
	) {
		return {
			exists: true,
			accessible: true,
			requiresOrgSwitch: true,
			workosOrganizationId: row.workos_organization_id,
			organizationName: row.organization_name,
		}
	}

	const [settings] = await db
		.select({ enabled: organizationSettings.access_requests_enabled })
		.from(organizationSettings)
		.where(eq(organizationSettings.organization_id, row.organization_id))
		.limit(1)

	if (settings?.enabled === false) throw errors.NOT_FOUND()

	if (!row.organization_name) throw errors.NOT_FOUND()

	return {
		exists: true,
		accessible: false,
		organizationName: row.organization_name,
		domain: null,
		myRequestStatus: 'none',
		lastRequestedAt: null,
	}
})
