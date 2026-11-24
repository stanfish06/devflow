import { apiBaseOrgRequired } from '../../../base'

export const getCurrentOrganizationProcedure = apiBaseOrgRequired.auth.organizations.getCurrent.handler(
	async ({ context, errors }) => {
		const { auth, services } = context
		const organization = services.directory.getOrganization(auth.workosOrganizationId)
		if (!organization) throw errors.NOT_FOUND()
		return { id: organization.id, name: organization.name, domains: [] }
	},
)
