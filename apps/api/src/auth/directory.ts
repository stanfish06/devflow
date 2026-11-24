import { Context, Effect } from 'effect'

export type DirectoryUser = {
	id: string
	email: string
	firstName: string | null
	lastName: string | null
	profilePictureUrl: string | null
	createdAt: string
}

/** `id` is the organization's external id (`organizations.workos_organization_id`, the JWT `org_id` claim). */
export type DirectoryOrganization = {
	id: string
	name: string
}

export type DirectoryMembershipStatus = 'active' | 'inactive'

export type DirectoryMembership = {
	id: string
	userId: string
	organizationId: string
	role: string
	status: DirectoryMembershipStatus
}

/**
 * In-memory users, organizations and memberships. The local install seeds one user, one
 * organization and an admin membership (see `devflow/local-auth.ts`); tests seed their own.
 */
export class UserDirectory {
	readonly users = new Map<string, DirectoryUser>()
	readonly organizations = new Map<string, DirectoryOrganization>()
	readonly memberships = new Map<string, DirectoryMembership>()

	reset(): void {
		this.users.clear()
		this.organizations.clear()
		this.memberships.clear()
	}

	addUser(data: Partial<DirectoryUser> & { id: string; email: string }): DirectoryUser {
		const user: DirectoryUser = {
			firstName: null,
			lastName: null,
			profilePictureUrl: null,
			createdAt: new Date().toISOString(),
			...data,
		}
		this.users.set(user.id, user)
		return user
	}

	addOrganization(data: DirectoryOrganization): DirectoryOrganization {
		this.organizations.set(data.id, data)
		return data
	}

	addMembership(
		data: Partial<DirectoryMembership> & { userId: string; organizationId: string },
	): DirectoryMembership {
		const membership: DirectoryMembership = {
			id: `om_${crypto.randomUUID()}`,
			role: 'member',
			status: 'active',
			...data,
		}
		this.memberships.set(membership.id, membership)
		return membership
	}

	getUser(userId: string): DirectoryUser | undefined {
		return this.users.get(userId)
	}

	/** Users with a membership (any status) in `organizationId`, or every user when omitted. */
	listUsers(filter: { organizationId?: string } = {}): DirectoryUser[] {
		const { organizationId } = filter
		if (organizationId === undefined) return [...this.users.values()]
		const memberIds = new Set(
			[...this.memberships.values()].filter((m) => m.organizationId === organizationId).map((m) => m.userId),
		)
		return [...this.users.values()].filter((user) => memberIds.has(user.id))
	}

	getOrganization(organizationId: string): DirectoryOrganization | undefined {
		return this.organizations.get(organizationId)
	}

	/** Memberships matching every given field; `statuses` defaults to active only. */
	listMemberships(filter: {
		userId?: string
		organizationId?: string
		statuses?: readonly DirectoryMembershipStatus[]
	}): DirectoryMembership[] {
		const statuses = filter.statuses ?? ['active']
		return [...this.memberships.values()].filter(
			(m) =>
				(filter.userId === undefined || m.userId === filter.userId) &&
				(filter.organizationId === undefined || m.organizationId === filter.organizationId) &&
				statuses.includes(m.status),
		)
	}

	isActiveMember(userId: string, organizationId: string): boolean {
		return this.listMemberships({ userId, organizationId }).length > 0
	}
}

/** Effect access to the user directory. */
export class Directory extends Context.Service<Directory, UserDirectory>()('Directory') {}

export function formatUserDisplayName(user: Pick<DirectoryUser, 'email' | 'firstName' | 'lastName'>): string {
	if (user.firstName && user.lastName) return `${user.firstName} ${user.lastName}`
	if (user.firstName) return user.firstName
	return user.email.split('@')[0] ?? user.email
}

/** Display names for the users found in the directory; unknown ids are left out. */
export const resolveUserDisplayNames = (userIds: readonly string[]) =>
	Effect.gen(function* () {
		const directory = yield* Directory
		const names = new Map<string, string>()
		for (const userId of new Set(userIds)) {
			const user = directory.getUser(userId)
			if (user) names.set(userId, formatUserDisplayName(user))
		}
		return names
	})

export const resolveUserDisplayName = (userId: string) =>
	resolveUserDisplayNames([userId]).pipe(Effect.map((names) => names.get(userId) ?? null))
