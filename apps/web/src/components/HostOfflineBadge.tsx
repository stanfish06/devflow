import { Badge } from '@devflow/ui/components/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@devflow/ui/components/tooltip'
import { cn } from '@devflow/ui/lib/utils'
import { WifiOff } from 'lucide-react'

interface HostOfflineBadgeProps {
	hostName?: string | null
	className?: string
}

export function HostOfflineBadge({ hostName, className }: HostOfflineBadgeProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge variant="destructive" className={cn('font-mono text-xs gap-1', className)}>
					<WifiOff className="h-3 w-3" />
					HOST OFFLINE
				</Badge>
			</TooltipTrigger>
			<TooltipContent className="font-mono text-xs">
				<p>
					{hostName
						? `The daemon on "${hostName}" is not running.`
						: 'The daemon for this session is not running.'}
				</p>
				<p className="text-muted-foreground mt-1">Start the daemon to continue this session.</p>
			</TooltipContent>
		</Tooltip>
	)
}
