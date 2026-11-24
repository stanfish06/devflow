import type { ConversationEvent } from '@devflow/ui/components/conversation-stream'
import React from 'react'

import { logger } from '@/lib/logger'

import { ConversationEventErrorFallback } from './ConversationEventErrorFallback'

interface ConversationEventRenderBoundaryProps {
	children: React.ReactNode
	event: ConversationEvent
	componentName?: string
}

interface State {
	hasError: boolean
	error?: Error
}

/**
 * Error boundary for conversation event content rendering.
 * Wraps the content slot (not the whole row) so row chrome remains visible
 * when content fails to render.
 */
export class ConversationEventRenderBoundary extends React.Component<ConversationEventRenderBoundaryProps, State> {
	constructor(props: ConversationEventRenderBoundaryProps) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		const { event, componentName = 'ConversationEventRow.content' } = this.props

		logger.error(`${componentName} render error:`, error, {
			eventId: event.id,
			eventType: event.eventType,
			toolName: event.toolName,
			componentStack: errorInfo.componentStack,
		})
	}

	render() {
		if (this.state.hasError && this.state.error) {
			return <ConversationEventErrorFallback error={this.state.error} event={this.props.event} />
		}

		return this.props.children
	}
}
