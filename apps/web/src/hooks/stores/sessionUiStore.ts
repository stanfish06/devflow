import { createContext, use } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

type BooleanUpdate = boolean | ((previous: boolean) => boolean)

interface SessionUiState {
	modelSelectorOpen: boolean
	setModelSelectorOpen: (open: BooleanUpdate) => void
}

/** Transient UI only: no persistence, session registry, editor callbacks or live-query snapshots. */
export function createSessionUiStore() {
	return createStore<SessionUiState>()((set) => ({
		modelSelectorOpen: false,
		setModelSelectorOpen: (update) =>
			set((state) => {
				const open = typeof update === 'function' ? update(state.modelSelectorOpen) : update
				return open === state.modelSelectorOpen ? state : { modelSelectorOpen: open }
			}),
	}))
}

export const SessionUiStoreContext = createContext<ReturnType<typeof createSessionUiStore> | null>(null)

/** Non-subscribing access for command owners; never republish getState() as page context. */
export function useSessionUiStoreApi() {
	const store = use(SessionUiStoreContext)
	if (!store) throw new Error('useSessionUiStoreApi must be used within SessionUiStoreProvider')
	return store
}

export function useSessionUiStore<T>(selector: (state: SessionUiState) => T): T {
	return useStore(useSessionUiStoreApi(), selector)
}
