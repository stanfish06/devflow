import { KeyboardShortcut } from '@devflow/ui/components/keyboard-shortcut'
import { SyncGridAnimation } from '@devflow/ui/components/sync-grid-animation'
import { ThemeSelector } from '@devflow/ui/components/theme-selector'
import { Tooltip, TooltipContent, TooltipTrigger } from '@devflow/ui/components/tooltip'
import { useNavigate } from '@tanstack/react-router'
import {
	AlertTriangle,
	Clock3,
	Crosshair,
	Download,
	LoaderCircle,
	MessageCircle,
	Settings,
	WifiOff,
} from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'

import { CodingAgentSetupDialog } from '@/components/CodingAgentSetupDialog'
import { DebugInfoModal } from '@/components/DebugInfoModal'
import { HotkeyScopeBoundary } from '@/components/HotkeyScopeBoundary'
import { useSyncInternal } from '@/components/providers/SyncProvider'
import ServerConnectionInfo from '@/components/ServerConnectionInfo'
import { HOTKEY_SCOPES } from '@/hooks/hotkeys/scopes'
import { useDiagnosticStore } from '@/hooks/stores/diagnosticStore'
import { useHotkeyHelpStore } from '@/hooks/stores/hotkeyHelpStore'
import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { useIsSyncing } from '@/hooks/useIsSyncing'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { artifactSidePanelTrace } from '@/lib/artifact-side-panel-trace'
import { buildConfig, buildDisplayLabel } from '@/lib/config'
import { navigateToSettings } from '@/lib/settings-navigation'

import { OrganizationSwitcher } from './OrganizationSwitcher'

function getFooterDegradedCount({
	syncForceMode,
	queryCount,
	offlineCount,
}: {
	syncForceMode: 'auto' | 'electric' | 'query'
	queryCount: number
	offlineCount: number
}): number {
	return syncForceMode === 'query' ? 0 : queryCount - offlineCount
}

export function Footer() {
	const navigate = useNavigate()
	const [isOrgSwitcherOpen, setIsOrgSwitcherOpen] = useState(false)
	const [themeSelectorOpen, setThemeSelectorOpen] = useState(false)
	const artifactSidePanelTraceEnabled = useDiagnosticStore((state) => state.artifactSidePanelTraceEnabled)
	const traceStatus = useSyncExternalStore(
		(listener) => artifactSidePanelTrace.subscribe(listener),
		() => artifactSidePanelTrace.status(),
		() => artifactSidePanelTrace.status(),
	)
	const isSyncing = useIsSyncing()
	const { tracker } = useSyncInternal()
	const networkStatus = useNetworkStatus()

	// Collections where both sync paths are failing (offline)
	const offlineCollections = useSyncExternalStore(
		(callback) => tracker.onOfflineChange((_name, _offline) => callback()),
		() => tracker.getOfflineCollections(),
	)

	// Collections using query fallback (degraded) — includes offline ones
	const syncModes = useSyncExternalStore(
		(callback) => tracker.onChange((_name, _mode) => callback()),
		() => tracker.getAllModes(),
	)
	const syncForceMode = useSettingsStore((state) => state.syncForceMode)
	const queryCount = Object.values(syncModes).filter((m) => m === 'query').length
	const offlineCount = offlineCollections.length
	const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
	// "degraded" = using query fallback but not fully offline
	const degradedCount = getFooterDegradedCount({ syncForceMode, queryCount, offlineCount })
	let traceFeedback = { label: 'Mark artifact panel flicker', icon: <Crosshair className="w-3 h-3" /> }
	switch (traceStatus.output.phase) {
		case 'capturing':
			traceFeedback = {
				label: 'Flicker marked; capturing five more seconds',
				icon: <Clock3 className="w-3 h-3" />,
			}
			break
		case 'saving':
			traceFeedback = {
				label: 'Saving artifact panel trace',
				icon: <LoaderCircle className="w-3 h-3 animate-spin" />,
			}
			break
		case 'ready-download':
			traceFeedback = { label: 'Trace ready for browser download', icon: <Download className="w-3 h-3" /> }
			break
		case 'download-requested':
			traceFeedback = { label: 'Browser trace download requested', icon: <Download className="w-3 h-3" /> }
			break
	}

	return (
		<footer className="relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3 bg-secondary text-xs mt-auto">
			<div
				id="left"
				className="flex min-w-0 flex-row items-center gap-2 overflow-hidden text-muted-foreground uppercase font-mono"
			>
				{buildConfig.devstackId ? buildDisplayLabel() : `devflow ${buildDisplayLabel()}`}
				{isSyncing && (
					<SyncGridAnimation variant="snake" size="xs" speed={120} className="text-muted-foreground" />
				)}
				{(degradedCount > 0 || offlineCount > 0) && (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => navigateToSettings(navigate, 'sync')}
								className={`flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono border transition-colors cursor-pointer ${
									offlineCount > 0
										? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20'
										: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-500/20'
								}`}
							>
								<AlertTriangle className="w-3 h-3" />
								{offlineCount > 0 ? 'Sync Offline' : `Sync Degraded (${degradedCount})`}
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{offlineCount > 0 && 'Sync Offline'}
							{offlineCount > 0 && degradedCount > 0 && ', '}
							{degradedCount > 0 && `Sync Degraded (${degradedCount})`}
							{' — click to view'}
						</TooltipContent>
					</Tooltip>
				)}
				{networkStatus === 'offline' && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono border border-destructive/30 bg-destructive/10 text-destructive">
								<WifiOff className="w-3 h-3" />
								network offline
							</span>
						</TooltipTrigger>
						<TooltipContent>No internet connection detected</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div id="center" className="justify-self-center">
				<button
					type="button"
					onClick={() => useHotkeyHelpStore.getState().open()}
					className="flex cursor-pointer items-center gap-1 px-1.5 py-0.5 text-xs font-mono text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
					aria-label="Open hotkeys guide"
				>
					<KeyboardShortcut size="xs">⇧+?</KeyboardShortcut>
					<span>Hotkeys</span>
				</button>
			</div>
			<div id="right" className="flex flex-row items-center justify-self-end gap-2">
				<OrganizationSwitcher isOpen={isOrgSwitcherOpen} setIsOpen={setIsOrgSwitcherOpen} />

				{import.meta.env.DEV && <DebugInfoModal />}
				{artifactSidePanelTraceEnabled ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => artifactSidePanelTrace.mark()}
								className="cursor-pointer px-1.5 py-0.5 text-xs font-mono border border-border bg-background text-foreground hover:bg-accent/10 transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
								aria-label={traceFeedback.label}
							>
								{traceFeedback.icon}
							</button>
						</TooltipTrigger>
						<TooltipContent>{traceFeedback.label}</TooltipContent>
					</Tooltip>
				) : null}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => navigateToSettings(navigate)}
							className="cursor-pointer px-1.5 py-0.5 text-xs font-mono border border-border bg-background text-foreground hover:bg-accent/10 transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
							aria-label="Settings"
						>
							<Settings className="w-3 h-3" />
						</button>
					</TooltipTrigger>
					<TooltipContent>
						<p className="flex items-center gap-1">
							<span>Settings</span>
							<KeyboardShortcut size="xs">{isMac ? '⌘+,' : 'Ctrl+,'}</KeyboardShortcut>
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<a
							href="https://github.com/devflow/devflow/issues/new/choose"
							target="_blank"
							rel="noopener noreferrer"
							className="px-1.5 py-0.5 text-xs font-mono border border-border bg-background text-foreground hover:bg-accent/10 transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
							aria-label="Send Feedback"
						>
							<MessageCircle className="w-3 h-3" />
						</a>
					</TooltipTrigger>
					<TooltipContent>Send Feedback</TooltipContent>
				</Tooltip>
				<HotkeyScopeBoundary
					scope={HOTKEY_SCOPES.THEME_SELECTOR}
					isActive={themeSelectorOpen}
					componentName="ThemeSelector"
				>
					<ThemeSelector
						enableHotkeys={true}
						hotkeyScope={HOTKEY_SCOPES.THEME_SELECTOR}
						showTooltip={true}
						onOpenChange={setThemeSelectorOpen}
					/>
				</HotkeyScopeBoundary>
				<ServerConnectionInfo />
			</div>
			<CodingAgentSetupDialog />
		</footer>
	)
}
