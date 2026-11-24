import { Button } from '@devflow/ui/components/button'
import { AlertCircle, RefreshCw } from 'lucide-react'
import React from 'react'

import { logger } from '@/lib/logger'

interface Props {
	children: React.ReactNode
	fallback?: (props: { error: Error; resetError: () => void }) => React.ReactNode
	variant: 'markdown' | 'artifact'
	componentName: string
	handleRefresh?: () => void
	refreshButtonText?: string
}

interface State {
	error?: Error
}

/** Logs render errors and shows a fallback; `handleRefresh` overrides the default reset. */
export class ErrorBoundary extends React.Component<Props, State> {
	state: State = {}

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		logger.error(`${this.props.componentName} Error:`, error, errorInfo)
	}

	handleReset = () => {
		if (this.props.handleRefresh) this.props.handleRefresh()
		else this.setState({ error: undefined })
	}

	render() {
		const { error } = this.state
		if (!error) return this.props.children

		if (this.props.fallback) return this.props.fallback({ error, resetError: this.handleReset })

		if (this.props.variant === 'markdown') {
			return (
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="text-destructive text-sm">Failed to render content</span>
						{this.props.handleRefresh && (
							<Button onClick={this.handleReset} variant="outline" size="sm" className="h-6 text-xs">
								{this.props.refreshButtonText || 'Refresh'}
							</Button>
						)}
					</div>
					<pre className="mt-2 p-2 bg-background-alt border border-border text-muted-foreground text-sm overflow-auto max-h-40">
						{error.message || 'Content unavailable'}
					</pre>
				</div>
			)
		}

		return (
			<div className="flex flex-col items-center justify-center p-8 gap-3 text-center">
				<AlertCircle className="w-8 h-8 text-destructive" />
				<h2 className="text-base font-semibold text-destructive">Couldn&apos;t display this artifact</h2>
				<p className="text-sm text-muted-foreground max-w-md">{error.message}</p>
				<Button onClick={this.handleReset} variant="outline" size="sm" className="gap-2">
					<RefreshCw className="w-4 h-4" />
					{this.props.refreshButtonText || 'Try Again'}
				</Button>
			</div>
		)
	}
}
