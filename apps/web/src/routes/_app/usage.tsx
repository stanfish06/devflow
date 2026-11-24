import { createFileRoute, Navigate } from '@tanstack/react-router'

import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { UsagePage } from '@/minimalist/components/UsagePage'

export const Route = createFileRoute('/_app/usage')({
	component: UsageRoute,
})

/** Your own usage history exists only in the minimalist interface. */
function UsageRoute() {
	const minimalist = useMinimalistLayout()
	if (minimalist) return <UsagePage />
	return <Navigate to="/" />
}
