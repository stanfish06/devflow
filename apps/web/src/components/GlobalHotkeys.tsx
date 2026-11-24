import { useNavigate, useRouter } from '@tanstack/react-router'

import {
	focusRightPaneSurface,
	focusMainAndReleaseSpatialDomFocus,
	moveKeyboardFocusLeft,
	moveKeyboardFocusRight,
} from '@/components/keyboard-focus-transfer'
import { getRightPaneController } from '@/components/right-pane-controller'
import { HOTKEY_SCOPES } from '@/hooks/hotkeys/scopes'
import { useAppHotkeys } from '@/hooks/hotkeys/useAppHotkeys'
import { useArtifactViewerStore } from '@/hooks/stores/artifactViewerStore'
import { useFocusStore } from '@/hooks/stores/focusStore'
import { useHotkeyHelpStore } from '@/hooks/stores/hotkeyHelpStore'
import { useSidebarStore } from '@/hooks/stores/sidebarStore'
import { useFocusSidebarFromRoute } from '@/hooks/useFocusSidebarFromRoute'
import { hotkeysCatalog } from '@/hotkeysCatalog'
import { navigateToSettings } from '@/lib/settings-navigation'

function rightPaneAvailable(): boolean {
	const viewer = useArtifactViewerStore.getState()
	return (
		getRightPaneController() !== null ||
		viewer.isSidebarViewerMounted ||
		viewer.isFullscreen ||
		viewer.isFullscreenModalOpen
	)
}

/**
 * Global hotkey handlers that apply across the entire application.
 * These handlers use the wildcard scope and are always active.
 */
export function GlobalHotkeys() {
	const isHotkeyHelpOpen = useHotkeyHelpStore((state) => state.isOpen)
	const navigate = useNavigate()
	const router = useRouter()

	const focusSidebarFromRoute = useFocusSidebarFromRoute()

	useAppHotkeys(
		hotkeysCatalog.global.shortcuts.hotkeyHelp.reactHotkeys,
		(e) => {
			e.preventDefault()
			useHotkeyHelpStore.getState().open()
		},
		{
			enableOnFormTags: false,
			enableOnContentEditable: false,
			preventDefault: true,
			useKey: true,
		},
	)

	useAppHotkeys(
		hotkeysCatalog.global.shortcuts.tasksView.reactHotkeys,
		(e) => {
			e.preventDefault()
			// One Tasks tab now; the layout it renders is a persisted preference,
			// not a route, so this always lands on the same place.
			navigate({ to: '/sessions', search: { tab: 'tasks' } })
		},
		{
			enabled: !isHotkeyHelpOpen,
			enableOnFormTags: false,
			enableOnContentEditable: false,
			preventDefault: true,
		},
	)

	// Open settings with the platform shortcut
	useAppHotkeys(
		hotkeysCatalog.global.shortcuts.settings.reactHotkeys,
		(e) => {
			e.preventDefault()
			navigateToSettings(navigate)
		},
		{
			enabled: !isHotkeyHelpOpen,
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
	)

	// Browser history navigation: Cmd+[ goes back and Cmd+] goes forward
	useAppHotkeys(
		'meta+[',
		(e) => {
			e.preventDefault()
			router.history.back()
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
			useKey: true,
		},
	)

	useAppHotkeys(
		'meta+]',
		(e) => {
			e.preventDefault()
			router.history.forward()
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
			useKey: true,
		},
	)

	useAppHotkeys(
		hotkeysCatalog.global.shortcuts.toggleSidebar.reactHotkeys,
		(e) => {
			e.preventDefault()
			const { sidebarCollapsed, setSidebarCollapsed } = useSidebarStore.getState()
			if (sidebarCollapsed) {
				setSidebarCollapsed(false)
				focusSidebarFromRoute()
			} else {
				setSidebarCollapsed(true)
				focusMainAndReleaseSpatialDomFocus()
			}
		},
		{
			scopes: [
				HOTKEY_SCOPES.ROOT,
				HOTKEY_SCOPES.SESSIONS_LIST,
				HOTKEY_SCOPES.SESSION_DETAIL,
				HOTKEY_SCOPES.TASK_DETAIL,
				HOTKEY_SCOPES.DRAFT_LAUNCHER,
			],
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
	)

	// Prevent escape key from exiting fullscreen mode
	// This is particularly important on macOS where ESC exits fullscreen by default
	useAppHotkeys(
		'escape',
		() => {
			// Empty handler - just prevents default browser behavior
		},
		{
			enableOnFormTags: true,
			preventDefault: true,
		},
	)

	// Spatial focus left: RIGHT_PANE → MAIN → LEFT_NAV.
	useAppHotkeys(
		'shift+h',
		(e) => {
			e.preventDefault()
			moveKeyboardFocusLeft(rightPaneAvailable())
			if (useFocusStore.getState().focusedArea === 'LEFT_NAV') {
				const { sidebarCollapsed, setSidebarCollapsed } = useSidebarStore.getState()
				if (sidebarCollapsed) setSidebarCollapsed(false)
				focusSidebarFromRoute()
			}
		},
		{
			scopes: [
				HOTKEY_SCOPES.ROOT,
				HOTKEY_SCOPES.SESSIONS_LIST,
				HOTKEY_SCOPES.SESSION_DETAIL,
				HOTKEY_SCOPES.TASK_DETAIL,
				HOTKEY_SCOPES.DRAFT_LAUNCHER,
				HOTKEY_SCOPES.ARTIFACT_PANEL,
				HOTKEY_SCOPES.ARTIFACT_FULLSCREEN,
				HOTKEY_SCOPES.ARTIFACT_V2_PANEL_REVIEW,
				HOTKEY_SCOPES.ARTIFACT_V2_FULLSCREEN_REVIEW,
			],
			enableOnFormTags: false,
		},
	)

	// Spatial focus right: LEFT_NAV → MAIN → RIGHT_PANE when mounted.
	useAppHotkeys(
		'shift+l',
		(e) => {
			e.preventDefault()
			if (useFocusStore.getState().focusedArea === 'MAIN') getRightPaneController()?.expand()
			moveKeyboardFocusRight(rightPaneAvailable())
			if (useFocusStore.getState().focusedArea === 'RIGHT_PANE') {
				requestAnimationFrame(() => focusRightPaneSurface())
			}
		},
		{
			scopes: [
				HOTKEY_SCOPES.ROOT,
				HOTKEY_SCOPES.SESSIONS_LIST,
				HOTKEY_SCOPES.SESSION_DETAIL,
				HOTKEY_SCOPES.TASK_DETAIL,
				HOTKEY_SCOPES.DRAFT_LAUNCHER,
				HOTKEY_SCOPES.ARTIFACT_PANEL,
				HOTKEY_SCOPES.ARTIFACT_FULLSCREEN,
				HOTKEY_SCOPES.ARTIFACT_V2_PANEL_REVIEW,
				HOTKEY_SCOPES.ARTIFACT_V2_FULLSCREEN_REVIEW,
			],
			enableOnFormTags: false,
		},
	)

	return null
}
