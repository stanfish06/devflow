import { apiBaseNoOrg } from '../../../base'

export const listUserOrganizationsProcedure = apiBaseNoOrg.auth.user.organizations.list.handler(async ({ context }) => {
	const { auth, services } = context

	const organizations = services.directory.listMemberships({ userId: auth.userId }).map((membership) => ({
		organizationId: membership.organizationId,
		organizationName: services.directory.getOrganization(membership.organizationId)?.name ?? 'Unknown Organization',
		role: membership.role,
		// One organization and no sign-in flow: point at the app itself.
		signInUrl: process.env.CLOUD_ORIGIN ?? 'http://localhost:5174',
		domains: [],
	}))

	return {
		organizations,
		activeOrganizationId: auth.organizationId ?? null,
	}
})
