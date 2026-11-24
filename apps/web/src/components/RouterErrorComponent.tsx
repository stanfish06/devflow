import { Button } from '@devflow/ui/components/button'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'

import { ErrorDetails } from '@/components/ErrorDetails'
import { logger } from '@/lib/logger'

/** TanStack Router's default error component: logs the error and offers a retry. */
export function RouterErrorComponent({ error, info, reset }: ErrorComponentProps) {
	useEffect(() => {
		logger.error('Router Error Boundary caught error:', error, info)
	}, [error, info])

	return (
		<div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center">
			<AlertCircle className="w-16 h-16 text-red-500 mb-4" />
			<h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
			<p className="text-muted-foreground mb-6 max-w-md">An unexpected error occurred.</p>
			<Button onClick={reset} className="gap-2">
				<RefreshCw className="w-4 h-4" />
				Try Again
			</Button>

			<ErrorDetails error={error} componentStack={info?.componentStack} />
		</div>
	)
}
