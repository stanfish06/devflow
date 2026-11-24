import { DayKeySchema } from '@devflow/api-contract/api/usage/windows'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import z from 'zod/v4'

import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { UsagePage } from '@/minimalist/components/UsagePage'

export const Route = createFileRoute('/_app/usage')({
	// The selected day lives in the URL, so a reload or a shared link reopens it. A malformed one is
	// dropped rather than failing the page.
	validateSearch: z.object({ day: DayKeySchema.optional().catch(undefined) }),
	component: UsageRoute,
})

/** Your own usage history exists only in the minimalist interface. */
function UsageRoute() {
	const minimalist = useMinimalistLayout()
	const { day } = Route.useSearch()
	const navigate = Route.useNavigate()
	if (!minimalist) return <Navigate to="/" />
	return (
		<UsagePage
			day={day ?? null}
			// Browsing days replaces the history entry, so Back still leaves the page.
			onDayChange={(next) =>
				void navigate({ search: (prev) => ({ ...prev, day: next ?? undefined }), replace: true })
			}
		/>
	)
}
