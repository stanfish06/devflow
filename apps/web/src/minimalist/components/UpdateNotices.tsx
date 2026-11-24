import { useNavigate } from '@tanstack/react-router'

import { useOutdatedHosts } from '@/hooks/live-queries/use-outdated-hosts'
import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { useMountEffect } from '@/hooks/useMountEffect'
import { buildConfig } from '@/lib/config'
import { useUi } from '@/minimalist/lib/ui-state'

function DaemonNotice({ count }: { count: number }) {
	const navigate = useNavigate()
	const { showToast } = useUi()
	useMountEffect(() => {
		useSettingsStore.getState().setLastNoticedAppVersion(buildConfig.version)
		showToast(
			count === 1
				? '1 daemon runs an older version than this app'
				: `${count} daemons run an older version than this app`,
			{ label: 'View', run: () => void navigate({ to: '/settings/daemons' }) },
		)
	})
	return null
}

/** One toast per app version when daemons run an older version than this app. */
export function WiredUpdateNotices() {
	const noticed = useSettingsStore((state) => state.lastNoticedAppVersion === buildConfig.version)
	const { outdatedHosts, isReady } = useOutdatedHosts()
	return !noticed && isReady && outdatedHosts.length > 0 ? <DaemonNotice count={outdatedHosts.length} /> : null
}
