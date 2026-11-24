import { HotkeysProvider } from '@devflow/hotkeys'
import { DiffStyleProvider } from '@devflow/ui/components/diff-style-provider'
import { SyncGridAnimation } from '@devflow/ui/components/sync-grid-animation'
import { ThemeProvider } from '@devflow/ui/components/theme-provider'
import { useLocation } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { ArtifactSharingDialogHost } from '@/components/artifact-sharing/ArtifactSharingDialogHost'
import { DaemonUpdateNoticeHandler } from '@/components/DaemonUpdateNoticeHandler'
import { WiredDiffWorkerPoolProvider } from '@/components/diffs/WiredDiffWorkerPoolProvider'
import { FocusDebugHud } from '@/components/FocusDebugHud'
import { FocusSourceHandler } from '@/components/FocusSourceHandler'
import { GlobalHotkeys } from '@/components/GlobalHotkeys'
import { HotkeyScopeDebugger } from '@/components/HotkeyScopeDebugger'
import { PreloadServiceProvider } from '@/components/providers/PreloadServiceProvider'
import { SyncProvider } from '@/components/providers/SyncProvider'
import { ReadyForInputNotificationHandler } from '@/components/ReadyForInputNotificationHandler'
import { SettingsSyncHandler } from '@/components/SettingsSyncHandler'
import { SharedArtifactProviders } from '@/components/shared-artifact/SharedArtifactProviders'
import { TaskDiffReviewMarksPruner } from '@/components/TaskDiffReviewMarksPruner'
import { UndoNotificationHandler } from '@/components/UndoNotificationHandler'
import { UnreadSessionsTracker } from '@/components/UnreadSessionsTracker'
import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { AuthProvider, useAuth } from '@/integrations/devflow/local-authkit'
import { providerModeForPath } from '@/lib/auth-routing'

export function ProviderProvider({ children }: { children: ReactNode }) {
	const diffStyle = useSettingsStore((s) => s.diffStyle)
	const setDiffStyle = useSettingsStore((s) => s.setDiffStyle)
	const pathname = useLocation({ select: (location) => location.pathname })
	const providerMode = providerModeForPath(pathname)

	return (
		<AuthProvider>
			<ThemeProvider storageKey="devflow-theme">
				{providerMode === 'shared' ? (
					<SharedArtifactProviders>{children}</SharedArtifactProviders>
				) : (
					<AuthGate>
						<AuthenticatedProviders diffStyle={diffStyle} setDiffStyle={setDiffStyle}>
							{children}
						</AuthenticatedProviders>
					</AuthGate>
				)}
			</ThemeProvider>
		</AuthProvider>
	)
}

/**
 * Holds the app until the local session loads. Electric reports a shape ready on any error,
 * including a missing token, so collections created before auth resolves read as empty.
 */
function AuthGate({ children }: { children: ReactNode }) {
	const { isLoading } = useAuth()
	if (isLoading)
		return (
			<div className="flex h-full w-full flex-1 items-center justify-center bg-background">
				<SyncGridAnimation variant="snake" size="lg" speed={120} className="text-accent" />
			</div>
		)
	return children
}

function AuthenticatedProviders({
	children,
	diffStyle,
	setDiffStyle,
}: {
	children: ReactNode
	diffStyle: ReturnType<typeof useSettingsStore.getState>['diffStyle']
	setDiffStyle: ReturnType<typeof useSettingsStore.getState>['setDiffStyle']
}) {
	const minimalist = useMinimalistLayout()
	return (
		<SyncProvider>
			<PreloadServiceProvider>
				<DiffStyleProvider diffStyle={diffStyle} onDiffStyleChange={setDiffStyle}>
					<HotkeysProvider initiallyActiveScopes={['*', '.']}>
						<FocusSourceHandler />
						{!minimalist && <GlobalHotkeys />}
						{/* The minimalist UI never toasts session events; its sidebar dots and OS notifications cover them. */}
						{!minimalist && <ReadyForInputNotificationHandler />}
						<UnreadSessionsTracker />
						<TaskDiffReviewMarksPruner />
						<UndoNotificationHandler />
						<SettingsSyncHandler />
						{/* The minimalist frame has its own daemon notice. */}
						{!minimalist && <DaemonUpdateNoticeHandler />}
						<ArtifactSharingDialogHost />
						<WiredDiffWorkerPoolProvider>{children}</WiredDiffWorkerPoolProvider>
						{import.meta.env.DEV ? <FocusDebugHud /> : null}
						<HotkeyScopeDebugger />
					</HotkeysProvider>
				</DiffStyleProvider>
			</PreloadServiceProvider>
		</SyncProvider>
	)
}
