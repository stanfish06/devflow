import { eq, useLiveQuery } from '@tanstack/react-db'
import { useLocalStorage } from '@uidotdev/usehooks'
import { useMemo } from 'react'

import { useSync } from '@/components/providers/SyncProvider'
import { useAuth } from '@/integrations/devflow/local-authkit'
import { isAttachedSessionsOnly } from '@/lib/daemon-version'

export interface EffectiveHost {
	host_id: string
	organization_id: string
	user_id: string
	host_name: string | null
}

export interface UseEffectiveHostResult {
	/** True once the current user's host query has resolved. */
	isReady: boolean
	/** Online hosts for the current user, ordered alphabetically by name. */
	availableHosts: EffectiveHost[]
	/** True when at least one host is online. */
	hasHosts: boolean
	/** The last-used host if it is online, otherwise the first online host; empty when none are online. */
	hostId: string
}

export function useEffectiveHost(): UseEffectiveHostResult {
	const { user } = useAuth()
	const [lastUsedHostId] = useLocalStorage<string | null>('devflow:lastUsedHostId', null)
	const { onlineHostsCollection } = useSync()
	const hostsQuery = useLiveQuery(
		(q) => {
			if (!user?.id) return undefined
			return q
				.from({ hosts: onlineHostsCollection })
				.where(({ hosts }) => eq(hosts.user_id, user.id))
				.select(({ hosts }) => ({
					host_id: hosts.host_id,
					organization_id: hosts.organization_id,
					user_id: hosts.user_id,
					host_name: hosts.host_name,
					capabilities: hosts.capabilities,
					status: hosts.status,
				}))
				.orderBy(({ hosts }) => hosts.host_name, 'asc')
		},
		[onlineHostsCollection, user?.id],
	)

	const availableHosts = useMemo<EffectiveHost[]>(
		() =>
			(hostsQuery.data ?? []).flatMap(({ host_id, organization_id, user_id, host_name, status, capabilities }) =>
				host_id && status === 'online' && !isAttachedSessionsOnly({ capabilities })
					? [{ host_id, organization_id, user_id, host_name }]
					: [],
			),
		[hostsQuery.data],
	)
	const lastUsedOnline = availableHosts.some((host) => host.host_id === lastUsedHostId)
	const hostId = lastUsedOnline && lastUsedHostId ? lastUsedHostId : (availableHosts[0]?.host_id ?? '')

	return { isReady: hostsQuery.isReady, availableHosts, hasHosts: availableHosts.length > 0, hostId }
}
