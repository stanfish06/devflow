import { DayKeySchema, DEFAULT_USAGE_PERIOD, UsagePeriodSchema } from '@devflow/api-contract/api/usage/windows'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import z from 'zod/v4'

import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { UsagePage } from '@/minimalist/components/UsagePage'

export const Route = createFileRoute('/_app/usage')({
	// The period and the selected day live in the URL, so a reload or a shared link reopens them. A
	// malformed value is dropped rather than failing the page; no period means the default, Month.
	validateSearch: z.object({
		period: UsagePeriodSchema.optional().catch(undefined),
		day: DayKeySchema.optional().catch(undefined),
	}),
	component: UsageRoute,
})

/** Your own usage history exists only in the minimalist interface. */
function UsageRoute() {
	const minimalist = useMinimalistLayout()
	const { period, day } = Route.useSearch()
	const navigate = Route.useNavigate()
	if (!minimalist) return <Navigate to="/" />
	return (
		<UsagePage
			day={day ?? null}
			// Browsing days replaces the history entry, so Back still leaves the page.
			onDayChange={(next) =>
				void navigate({ search: (prev) => ({ ...prev, day: next ?? undefined }), replace: true })
			}
			period={period ?? DEFAULT_USAGE_PERIOD}
			// Changing the period is a step of its own: it pushes an entry, so Back undoes it.
			onPeriodChange={(next) =>
				void navigate({
					search: (prev) => ({ ...prev, period: next === DEFAULT_USAGE_PERIOD ? undefined : next }),
				})
			}
		/>
	)
}
