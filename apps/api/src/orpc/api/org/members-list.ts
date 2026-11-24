import type { DirectoryUser } from '../../../auth/directory'
import { apiBaseOrgRequired } from '../../base'

const toMember = (user: DirectoryUser) => ({
	id: user.id,
	email: user.email,
	firstName: user.firstName ?? undefined,
	lastName: user.lastName ?? undefined,
	profilePictureUrl: user.profilePictureUrl ?? undefined,
})

export const listOrgMembersProcedure = apiBaseOrgRequired.organization.members.list.handler(async ({ context }) => {
	const { auth, services } = context
	return { members: services.directory.listUsers({ organizationId: auth.workosOrganizationId }).map(toMember) }
})

export const listActiveOrgMembersProcedure = apiBaseOrgRequired.organization.members.listActive.handler(
	async ({ context }) => {
		const { auth, services } = context
		const activeUserIds = new Set(
			services.directory.listMemberships({ organizationId: auth.workosOrganizationId }).map((m) => m.userId),
		)
		return {
			members: services.directory
				.listUsers({ organizationId: auth.workosOrganizationId })
				.filter((user) => activeUserIds.has(user.id))
				.map(toMember),
		}
	},
)
