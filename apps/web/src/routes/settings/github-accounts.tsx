import { createFileRoute, Navigate } from '@tanstack/react-router'

import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'

export const Route = createFileRoute('/settings/github-accounts')({
	component: GithubAccountsSettingsRoute,
})

/** The minimalist layout renders the GitHub accounts page itself; the standard settings have no such page. */
function GithubAccountsSettingsRoute() {
	const minimalist = useMinimalistLayout()
	if (minimalist) return null
	return <Navigate to="/settings/general" replace />
}
