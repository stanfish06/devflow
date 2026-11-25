import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

import { useBrowserAuth as useAuth } from '@/hooks/use-browser-auth'
import { type HostView, useHosts } from '@/minimalist/lib/data'
import { type WorkingHost, workingHostStore } from '@/minimalist/lib/working-host-store'

export type { WorkingHost } from '@/minimalist/lib/working-host-store'

export type WorkingHostState = 'all' | 'online' | 'offline' | 'missing'

/** Before sign-in there is nobody to remember a choice for, so it stays in memory. */
const signedOut = createStore<{ choice: WorkingHost | null; set: (choice: WorkingHost) => void }>()((set) => ({
	choice: null,
	set: (choice) => set({ choice }),
}))

/** The first visit's pick: the first online host in the usual order, else every host. */
export function initialWorkingHost(hosts: readonly Pick<HostView, 'online' | 'host'>[]): WorkingHost {
	return hosts.find((entry) => entry.online)?.host.host_id ?? 'all'
}

/** Where the choice stands against the hosts you have now. Neither offline nor missing changes it. */
export function workingHostState(id: WorkingHost, host: Pick<HostView, 'online'> | null): WorkingHostState {
	if (id === 'all') return 'all'
	if (!host) return 'missing'
	return host.online ? 'online' : 'offline'
}

/**
 * The working host on this device: what the sidebar masks by and where new tasks start. It is
 * chosen once for you on the first visit, then only changes when you pick another one.
 */
export function useWorkingHost(): {
	id: WorkingHost
	host: HostView | null
	state: WorkingHostState
	/** False until the host list has loaded; a saved host can't be told missing before then. */
	isReady: boolean
	set: (choice: WorkingHost) => void
} {
	const { user, organizationId } = useAuth()
	const { hosts, isReady } = useHosts()
	const store = organizationId && user ? workingHostStore(organizationId, user.id) : signedOut
	const choice = useStore(store, (state) => state.choice)
	const initial = isReady ? initialWorkingHost(hosts) : null
	// Saved on first resolve, so a host coming online or going away later never moves it.
	useEffect(() => {
		if (choice === null && initial !== null) store.getState().set(initial)
	}, [choice, initial, store])
	const id = choice ?? initial ?? 'all'
	const host = id === 'all' ? null : (hosts.find((entry) => entry.host.host_id === id) ?? null)
	return {
		id,
		host,
		state: !isReady && id !== 'all' && !host ? 'offline' : workingHostState(id, host),
		isReady,
		set: (next) => store.getState().set(next),
	}
}
