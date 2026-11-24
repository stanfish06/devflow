import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'

/** A host id, or `'all'` for every host at once. (`string & {}` keeps the `'all'` literal visible.) */
export type WorkingHost = (string & {}) | 'all'

type WorkingHostState = {
	/** null until this device has chosen, so the first load can pick for you exactly once. */
	choice: WorkingHost | null
	set: (choice: WorkingHost) => void
}

/** A stored choice is any non-empty string; anything else counts as never chosen. */
export function parseWorkingHostChoice(value: unknown): WorkingHost | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

// Storage denial or a full quota must not break the switcher; the choice then lasts for the page.
const browserStorage: StateStorage = {
	getItem: (key) => {
		try {
			return localStorage.getItem(key)
		} catch {
			return null
		}
	},
	setItem: (key, value) => {
		try {
			localStorage.setItem(key, value)
		} catch {
			console.warn('Working host could not be saved locally')
		}
	},
	removeItem: (key) => {
		try {
			localStorage.removeItem(key)
		} catch {
			console.warn('Working host could not be cleared locally')
		}
	},
}

/**
 * The working host on this device, kept apart per organization and user: host ids belong to an
 * (org, user) registration, so each org you use here keeps its own choice.
 */
export function createWorkingHostStore(organizationId: string, userId: string, storage?: StateStorage) {
	return createStore<WorkingHostState>()(
		persist(
			(set) => ({
				choice: null,
				set: (choice) => set({ choice }),
			}),
			{
				name: `working-host:v1:${encodeURIComponent(organizationId)}:${encodeURIComponent(userId)}`,
				storage: createJSONStorage(() => storage ?? browserStorage),
				partialize: (state) => ({ choice: state.choice }),
				merge: (persisted, current) => ({
					...current,
					choice: parseWorkingHostChoice((persisted as { choice?: unknown } | undefined)?.choice),
				}),
			},
		),
	)
}

export type WorkingHostStore = ReturnType<typeof createWorkingHostStore>

const stores = new Map<string, WorkingHostStore>()

/** One shared store per (org, user), so the switcher, sidebar and composer all see a change at once. */
export function workingHostStore(organizationId: string, userId: string): WorkingHostStore {
	const key = `${organizationId}\u0000${userId}`
	let store = stores.get(key)
	if (!store) {
		store = createWorkingHostStore(organizationId, userId)
		stores.set(key, store)
	}
	return store
}

/** Tests start each case from a fresh device. */
export function resetWorkingHostStoresForTests() {
	stores.clear()
}
