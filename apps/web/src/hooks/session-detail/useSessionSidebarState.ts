import { useSessionStorage } from '@uidotdev/usehooks'
import { useCallback } from 'react'

import type { SidebarTab } from '@/components/sidebar-widget/sidebar-tabs'
import { SESSION_SIDEBAR_STATE_KEY_PREFIX } from '@/lib/preferences'

export interface SessionSidebarState {
	currentTab: SidebarTab
	currentArtifactId: string | null
}

const DEFAULT_SESSION_SIDEBAR_STATES = {
	graph: { currentTab: 'graph', currentArtifactId: null },
	minimap: { currentTab: 'minimap', currentArtifactId: null },
} satisfies Record<'graph' | 'minimap', SessionSidebarState>

export function useSessionSidebarState(sessionId: string, defaultTab: keyof typeof DEFAULT_SESSION_SIDEBAR_STATES) {
	const [storedState, setStoredState] = useSessionStorage<SessionSidebarState | undefined>(
		`${SESSION_SIDEBAR_STATE_KEY_PREFIX}${sessionId}`,
		undefined,
	)
	const state = storedState ?? DEFAULT_SESSION_SIDEBAR_STATES[defaultTab]
	const setCurrentTab = useCallback(
		(currentTab: SidebarTab) => setStoredState({ ...state, currentTab }),
		[setStoredState, state],
	)
	const setCurrentArtifactId = useCallback(
		(currentArtifactId: string | null) => setStoredState({ ...state, currentArtifactId }),
		[setStoredState, state],
	)

	return {
		state,
		hasStoredState: storedState !== undefined,
		setState: setStoredState,
		setCurrentTab,
		setCurrentArtifactId,
	}
}
