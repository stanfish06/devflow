import { useHostUsageLimits } from '@/hooks/live-queries/use-host-usage-limits'
import { useSessionHostState } from '@/hooks/live-queries/use-session-host-state'
import { getSessionHostRegistrationIdentity } from '@/lib/session-host-identity'
import { deriveSessionHostView } from '@/lib/session-host-state'
import type { SessionStatusHost } from '@/lib/session-status-label'

import type { SessionDetailSession } from './useSessionDetailData'

/** Host status for the session detail page: online/colocated detection and the resolved host display name. */
export function useSessionHostStatus(session: SessionDetailSession | undefined) {
	const usageLimits = useHostUsageLimits(getSessionHostRegistrationIdentity(session), session?.coding_agent)
	const { state: hostState, isLocal: isColocated, hostLabel, shortHostId } = useSessionHostState(session)
	const { isHostOffline, isHostStarting, isHostUpdating } = deriveSessionHostView(hostState)
	const statusHost: SessionStatusHost | null =
		hostState && hostLabel ? { state: hostState, hostLabel, isLocal: isColocated } : null
	const hostDisplayName =
		hostLabel && shortHostId && hostLabel !== shortHostId ? `${hostLabel} (${shortHostId})` : shortHostId

	return {
		isColocated,
		isHostOffline,
		isHostStarting,
		isHostUpdating,
		hostDisplayName,
		statusHost,
		usageLimits,
	}
}
