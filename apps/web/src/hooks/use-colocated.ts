export interface LocalHostIdState {
	localHostId: string | null
	isResolved: boolean
}

const BROWSER_STATE: LocalHostIdState = { localHostId: null, isResolved: true }

/** Host id of a daemon on this machine. A browser can't tell which host shares its machine, so none is. */
export function useLocalHostIdState(): LocalHostIdState {
	return BROWSER_STATE
}

export function useLocalHostId(): string | null {
	return null
}

/** Whether `hostId` runs on this machine; always false in the browser. */
export function useIsColocated(_hostId: string | null | undefined) {
	return { isColocated: false, localHostId: null }
}
