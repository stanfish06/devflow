import { Button } from '@devflow/ui/components/button'
import { Card, CardHeader } from '@devflow/ui/components/card'
import { Separator } from '@devflow/ui/components/separator'
import { Skeleton } from '@devflow/ui/components/skeleton'
import { SyncGridAnimation } from '@devflow/ui/components/sync-grid-animation'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertCircle, Building2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { CreateOrganizationLink } from '@/components/organizations/CreateOrganizationLink'
import { OrganizationListItem } from '@/components/organizations/OrganizationListItem'
import { useBrowserAuth } from '@/hooks/use-browser-auth'
import { logger } from '@/lib/logger'
import { useApi } from '@/orpc/client'

export const Route = createFileRoute('/_app/auth/organizations/select')({
	component: OrganizationSelectPage,
})

function OrganizationSelectPage() {
	const { isLoading: isAuthLoading, switchOrganization } = useBrowserAuth()
	const navigate = useNavigate()
	const [isSwitching, setIsSwitching] = useState(false)

	const { queryClient: api } = useApi()

	// Queries
	const {
		data: organizationListData,
		isLoading: organizationListIsLoading,
		isError: organizationListIsError,
		refetch: refetchOrganizationList,
	} = useQuery(
		api.auth.user.organizations.list.queryOptions({
			enabled: !isAuthLoading,
			refetchInterval: 5_000,
			retry: 3,
			retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
		}),
	)

	const handleOrganizationSelect = async (organizationId: string) => {
		setIsSwitching(true)
		try {
			await switchOrganization({ organizationId })
			navigate({ to: '/' })
		} catch (error) {
			logger.error('Failed to select organization:', error)
			toast.error('Failed to select organization. Please try again.')
			setIsSwitching(false)
		}
	}

	// Derived state
	const organizations = organizationListData?.organizations ?? []
	const isLoading = isAuthLoading || organizationListIsLoading
	const isError = organizationListIsError
	const isDisabled = isSwitching

	// Loading state
	if (isLoading) {
		return (
			<div className="flex flex-col h-full grow items-center justify-center bg-background">
				<Card className="w-md p-6 text-center">
					<CardHeader className="flex flex-col gap-4 w-full items-center">
						<SyncGridAnimation
							variant="snake"
							speed={120}
							className="mx-auto mb-4 w-12 text-muted-foreground"
						/>
						<p className="text-xl font-semibold">Loading Organizations</p>
						<p className="text-muted-foreground">Please wait while we fetch your organizations…</p>
					</CardHeader>
				</Card>
			</div>
		)
	}

	// Error state
	if (isError) {
		return (
			<div className="flex flex-col h-full grow items-center justify-center bg-background">
				<Card className="w-md p-6 text-center">
					<CardHeader className="flex flex-col gap-4 w-full items-center">
						<AlertCircle className="mx-auto mb-4 size-12 text-destructive" />
						<p className="text-xl font-semibold">Unable to Load Organizations</p>
						<p className="text-muted-foreground">
							We couldn&apos;t fetch your organizations. Please check your connection and try again.
						</p>
						<Button onClick={() => void refetchOrganizationList()} className="mt-4">
							<RefreshCw className="mr-2 h-4 w-4" />
							Retry
						</Button>
					</CardHeader>
				</Card>
			</div>
		)
	}

	return (
		<div className="flex flex-col h-full grow items-center justify-center bg-background">
			<Card className="w-md p-6 text-center">
				<CardHeader className="flex flex-col gap-2 w-full items-center">
					<Building2 className="mx-auto mb-4 size-12 text-muted-foreground" />
					<p className="text-xl font-semibold">Organization Required</p>
					<p className="text-muted-foreground">Please select or create an organization.</p>
				</CardHeader>
				<Separator />

				{/* Organizations list */}
				{organizationListIsLoading ? (
					<div className="space-y-2 p-4">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				) : organizations.length > 0 ? (
					<div className="flex flex-col gap-2 my-4">
						{organizations.map((org) => (
							<OrganizationListItem
								key={org.organizationId}
								organization={org}
								domains={org.domains}
								onSelect={handleOrganizationSelect}
								isLoading={isSwitching}
								disabled={isDisabled}
							/>
						))}
					</div>
				) : (
					<div className="border border-dashed p-8 text-center my-4">
						<p className="text-sm text-muted-foreground">You don&apos;t belong to any organizations yet</p>
					</div>
				)}

				<div className="flex flex-row justify-between items-center my-4">
					<Separator className="!w-[45%]" />
					OR
					<Separator className="!w-[45%]" />
				</div>

				{/* Create organization link */}
				<CreateOrganizationLink disabled={isDisabled} className="w-full" />
			</Card>
		</div>
	)
}
