import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import type { NotificationDestination } from '@/lib/notifications/notification-row'

type PageDestination = Extract<NotificationDestination, { kind: 'session' | 'workspace-setup' }>

/** Opens a session, or a task with its workspace setup in focus. */
export function useNotificationDestinationNavigation(): (destination: PageDestination) => void {
	const navigate = useNavigate()

	return useCallback(
		(destination) => {
			if (destination.kind === 'session') {
				navigate({ to: '/sessions/$sessionId', params: { sessionId: destination.sessionId } })
				return
			}

			navigate({
				to: '/tasks/$taskId',
				params: { taskId: destination.taskId },
				search: { focus: 'workspace' },
			})
		},
		[navigate],
	)
}
