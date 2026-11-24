import { Switch } from '@devflow/ui/components/switch'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { useDiagnosticStore } from '@/hooks/stores/diagnosticStore'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useApi } from '@/orpc/client'

const ENV_VARS = {
	VITE_PUBLIC_BUILD_VERSION: import.meta.env.VITE_PUBLIC_BUILD_VERSION,
	VITE_PUBLIC_DEVFLOW_API_ORIGIN: import.meta.env.VITE_PUBLIC_DEVFLOW_API_ORIGIN,
	VITE_PUBLIC_SYNC_ORIGIN: import.meta.env.VITE_PUBLIC_SYNC_ORIGIN,
	DEV: import.meta.env.DEV,
	MODE: import.meta.env.MODE,
	PROD: import.meta.env.PROD,
	BASE_URL: import.meta.env.BASE_URL,
}

export function DiagnosticsSettingsSection() {
	const { queryClient: api } = useApi()

	// Fetch user info for diagnostics
	const {
		data: userInfoData,
		isLoading: userInfoIsLoading,
		error: userInfoError,
	} = useQuery(api.auth.user.info.queryOptions())

	const networkStatus = useNetworkStatus()
	const artifactSidePanelTraceEnabled = useDiagnosticStore((state) => state.artifactSidePanelTraceEnabled)
	const setArtifactSidePanelTraceEnabled = useDiagnosticStore((state) => state.setArtifactSidePanelTraceEnabled)
	let userInfoContent: ReactNode = <p className="text-muted-foreground">No data</p>
	if (userInfoIsLoading) userInfoContent = <p className="text-muted-foreground">Loading…</p>
	else if (userInfoError) userInfoContent = <p className="text-destructive">Error: {userInfoError.message}</p>
	else if (userInfoData) {
		userInfoContent = (
			<>
				<div className="flex justify-between">
					<span className="text-muted-foreground">userId:</span>
					<span className="text-foreground">{userInfoData.userId}</span>
				</div>
				<div className="flex justify-between">
					<span className="text-muted-foreground">workosOrganizationId:</span>
					<span className="text-foreground">{userInfoData.workosOrganizationId}</span>
				</div>
				<div className="flex justify-between">
					<span className="text-muted-foreground">organizationId:</span>
					<span className="text-foreground">{userInfoData.organizationId}</span>
				</div>
			</>
		)
	}

	return (
		<div className="space-y-6">
			<section>
				<h3 className="text-sm font-semibold mb-2 text-muted-foreground">Artifact Viewer</h3>
				<div className="bg-muted/50 rounded-md p-3">
					<div className="flex items-center justify-between gap-4">
						<p className="text-sm font-medium">Artifact side-panel tracing</p>
						<Switch
							checked={artifactSidePanelTraceEnabled}
							onCheckedChange={setArtifactSidePanelTraceEnabled}
							aria-label="Artifact side-panel tracing"
						/>
					</div>
				</div>
			</section>
			{/* User Info Section */}
			<section>
				<h3 className="text-sm font-semibold mb-2 text-muted-foreground">User Info</h3>
				<div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-1">{userInfoContent}</div>
			</section>

			{/* Environment Variables Section */}
			<section>
				<h3 className="text-sm font-semibold mb-2 text-muted-foreground">Environment Variables</h3>
				<div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-1">
					{Object.entries(ENV_VARS).map(([key, value]) => (
						<div key={key} className="flex justify-between gap-4">
							<span className="text-muted-foreground shrink-0">{key}:</span>
							<span className="text-foreground truncate" title={String(value ?? 'undefined')}>
								{value === undefined ? (
									<span className="text-muted-foreground/50">undefined</span>
								) : value === '' ? (
									<span className="text-muted-foreground/50">(empty)</span>
								) : (
									String(value)
								)}
							</span>
						</div>
					))}
				</div>
			</section>

			{/* Log Paths Section - placeholder for future */}
			<section>
				<h3 className="text-sm font-semibold mb-2 text-muted-foreground">Log Paths</h3>
				<div className="bg-muted/50 rounded-md p-3 font-mono text-xs">
					<p className="text-muted-foreground">
						Log path information will be available when connected to daemon.
					</p>
				</div>
			</section>

			{/* Network Section */}
			<section>
				<h3 className="text-sm font-semibold mb-2 text-muted-foreground">Network</h3>
				<div className="bg-muted/50 rounded-md p-3 font-mono text-xs space-y-1">
					<div className="flex justify-between">
						<span className="text-muted-foreground">status:</span>
						<span className={networkStatus === 'online' ? 'text-green-500' : 'text-destructive'}>
							{networkStatus}
						</span>
					</div>
				</div>
			</section>
		</div>
	)
}
