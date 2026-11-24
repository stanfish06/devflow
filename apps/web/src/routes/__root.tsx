import { CodeLayerToaster } from '@devflow/ui/components/CodeLayerToaster'
import { TooltipProvider } from '@devflow/ui/components/tooltip'
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'

import { CommandPalette } from '@/components/CommandPalette'
import { DynamicDocumentTitle } from '@/components/DynamicDocumentTitle'
import { Footer } from '@/components/Footer'
import { HotkeyHelpModal } from '@/components/HotkeyHelpModal'
import { ProviderProvider } from '@/components/ProviderProvider'
import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { isSharedArtifactRoute } from '@/lib/auth-routing'
import type { PreloadService } from '@/services/preload-service'

interface MyRouterContext {
	queryClient: QueryClient
	preloadService: PreloadService | null
}

const MinimalistFrame = lazy(() => import('@/minimalist/MinimalistFrame'))

function AppFrame({ roundedCornersEnabled }: { roundedCornersEnabled: boolean }) {
	const minimalist = useMinimalistLayout()
	if (minimalist)
		return (
			<Suspense fallback={null}>
				<MinimalistFrame>
					<DynamicDocumentTitle />
					<Outlet />
				</MinimalistFrame>
			</Suspense>
		)
	return <RootAppFrame roundedCornersEnabled={roundedCornersEnabled} />
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	component: function RootLayout() {
		const roundedCornersEnabled = useSettingsStore((s) => s.roundedCornersEnabled)
		const pathname = useRouterState({ select: (state) => state.location.pathname })
		const showsStandardToaster = !useMinimalistLayout() || isSharedArtifactRoute(pathname)

		return (
			<TooltipProvider>
				{showsStandardToaster && <CodeLayerToaster />}
				<ProviderProvider>
					{isSharedArtifactRoute(pathname) ? (
						<Outlet />
					) : (
						<AppFrame roundedCornersEnabled={roundedCornersEnabled} />
					)}
				</ProviderProvider>
			</TooltipProvider>
		)
	},
})

function RootAppFrame({ roundedCornersEnabled }: { roundedCornersEnabled: boolean }) {
	return (
		<>
			<DynamicDocumentTitle />
			<div
				className={`flex h-dvh max-h-dvh min-h-dvh flex-col overflow-hidden bg-background${roundedCornersEnabled ? ' rounded-corners' : ''}`}
			>
				<div className="flex min-h-0 flex-1 overflow-auto">
					<Outlet />
				</div>
				<CommandPalette />
				<HotkeyHelpModal />
				<Footer />
			</div>
		</>
	)
}
