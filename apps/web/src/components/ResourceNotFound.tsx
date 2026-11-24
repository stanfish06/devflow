import { Button } from '@devflow/ui/components/button'
import { Card } from '@devflow/ui/components/card'
import { Link } from '@tanstack/react-router'
import { FileQuestion } from 'lucide-react'

interface ResourceNotFoundProps {
	title?: string
	description?: string
	backTo?: {
		label: string
		path: string
	}
}

export function ResourceNotFound({
	title = 'Resource Not Found',
	description = 'This resource does not exist or was deleted.',
	backTo,
}: ResourceNotFoundProps) {
	return (
		<div className="flex items-center justify-center h-full">
			<Card className="p-8 text-center max-w-md">
				<FileQuestion className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
				<h2 className="font-mono uppercase tracking-wider mb-2">{title}</h2>
				<p className="text-sm text-muted-foreground mb-6">{description}</p>
				<div className="flex flex-col gap-3 items-center">
					{backTo && (
						<Button variant="ghost" size="sm" asChild>
							<Link to={backTo.path}>{backTo.label}</Link>
						</Button>
					)}
				</div>
			</Card>
		</div>
	)
}
