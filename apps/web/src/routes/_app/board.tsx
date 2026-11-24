import { createFileRoute, Navigate } from '@tanstack/react-router'
import z from 'zod/v4'

import { useMinimalistLayout } from '@/hooks/use-minimalist-layout'
import { BoardPage } from '@/minimalist/components/BoardPage'

export const Route = createFileRoute('/_app/board')({
	validateSearch: z.object({ layout: z.enum(['board', 'list']).optional() }),
	component: BoardRoute,
})

/** The minimalist board; the standard interface has its own on the tasks page. */
function BoardRoute() {
	const minimalist = useMinimalistLayout()
	const { layout } = Route.useSearch()
	const navigate = Route.useNavigate()
	if (!minimalist) return <Navigate to="/" />
	return (
		<BoardPage
			layout={layout ?? 'board'}
			onLayout={(next) => void navigate({ search: { layout: next === 'board' ? undefined : next } })}
		/>
	)
}
