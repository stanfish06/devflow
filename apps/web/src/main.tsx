// must be imported before React and React DOM so its devtools hook sees React attach.
// Dev-server only: every `vite build` aliases 'react-scan' to a no-op stub (see
// disable-react-scan-in-release-builds in vite.config.ts), so no channel ships it.
import { scan } from 'react-scan'

scan({
	enabled: false,
	showToolbar: true,
})

import { QueryClient } from '@tanstack/react-query'
import { createBrowserHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'

import { DevWarmupNotice } from '@/components/DevWarmupNotice'
import { RouterErrorComponent } from '@/components/RouterErrorComponent'

import './styles.css'
import { installFileDropNavigationGuard } from '@/lib/file-drop-navigation-guard'
import { migrateArtifactViewMode } from '@/lib/preferences'
import { shouldRetryQuery } from '@/lib/query-retry'

import { Provider as QueryProvider } from './integrations/tanstack-query/root-provider'
import reportWebVitals from './reportWebVitals'
// Import the generated route tree
import { routeTree } from './routeTree.gen'

// The app ships no favicon, so tabs show the browser's default icon. A devstack tab gets its own
// coloured icon so you can tell stacks apart; that's the only icon link the page ever has.
const devstackId = import.meta.env.VITE_PUBLIC_DEVSTACK_ID
if (devstackId) {
	document.title = devstackId
	const devstackColor = `#${import.meta.env.VITE_PUBLIC_DEVSTACK_COLOR}`
	if (/^#[\da-f]{6}$/i.test(devstackColor)) {
		const favicon = document.createElement('link')
		favicon.rel = 'icon'
		favicon.type = 'image/svg+xml'
		favicon.href = `data:image/svg+xml,${encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${devstackColor}"/><path d="M19 46 29 18h7l10 28h-7l-2-7H27l-2 7Zm10-13h6l-3-9Z" fill="#1b1e28"/></svg>`,
		)}`
		document.head.append(favicon)
	}
}

// Run localStorage migrations before React renders
migrateArtifactViewMode()
// Stop a file dropped outside a drop zone from replacing the app with the file.
installFileDropNavigationGuard()

// Create a new router instance
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: shouldRetryQuery },
	},
})
const history = createBrowserHistory()
const router = createRouter({
	routeTree,
	history,
	context: {
		queryClient,
		preloadService: null,
	},
	defaultPreload: 'intent',
	scrollRestoration: true,
	defaultStructuralSharing: true,
	defaultPreloadStaleTime: 0,
	defaultErrorComponent: RouterErrorComponent,
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}

// Render the app
const rootElement = document.getElementById('app')
if (rootElement && !rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement)
	root.render(
		<StrictMode>
			<QueryProvider queryClient={queryClient}>
				<RouterProvider router={router} />
			</QueryProvider>
			{import.meta.env.DEV && <DevWarmupNotice />}
		</StrictMode>,
	)
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()
