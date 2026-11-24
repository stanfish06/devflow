import { HotkeyScopeBoundary } from '@/components/HotkeyScopeBoundary'
import { SessionsPage } from '@/components/sessions-page/SessionsPage'
import type { SessionsRouteTab, SessionsRouteTo } from '@/components/sessions-page/sessionsRoute'
import { HOTKEY_SCOPES } from '@/hooks/hotkeys/scopes'

export function SessionsRoutePage({ tab, routeTo }: { tab: SessionsRouteTab; routeTo: SessionsRouteTo }) {
	return (
		<HotkeyScopeBoundary scope={HOTKEY_SCOPES.SESSIONS_LIST} componentName="SessionsListPage">
			<div className="flex flex-col h-full overflow-hidden">
				<SessionsPage tab={tab} routeTo={routeTo} />
			</div>
		</HotkeyScopeBoundary>
	)
}
