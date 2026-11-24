import { Card, CardHeader } from '@devflow/ui/components/card'
import { Separator } from '@devflow/ui/components/separator'
import { createFileRoute } from '@tanstack/react-router'
import { Building2 } from 'lucide-react'

import { OrganizationCreateForm } from '@/components/organizations/OrganizationCreateForm'
import { useAuth } from '@/integrations/devflow/local-authkit'

// devflow staff (devflow.dev / devflow.com) may still create orgs even
// when new org creation is blocked for the environment.
function isStaffEmail(email: string | undefined): boolean {
	const domain = email?.split('@')[1]?.toLowerCase()
	return domain === 'devflow.dev' || domain === 'devflow.com'
}

export const Route = createFileRoute('/_app/auth/organizations/create')({
	component: OrganizationCreatePage,
})

function OrganizationCreationBlocked() {
	return (
		<div className="flex flex-col h-full grow items-center justify-center bg-background">
			<Card className="w-md p-6">
				<CardHeader className="flex flex-col gap-2 w-full items-center text-center">
					<Building2 className="mx-auto mb-4 size-12 text-muted-foreground" />
					<p className="text-xl font-semibold">New Organizations Closed</p>
				</CardHeader>
				<Separator className="my-4" />
				<div className="flex flex-col gap-4 text-sm text-muted-foreground">
					<p>
						devflow Cloud is shutting down as devflow joins Factory, so it no longer accepts new
						organizations.{' '}
						<a
							href="https://devflow.com/blog/devflow-joins-factory"
							target="_blank"
							rel="noopener noreferrer"
							className="underline text-foreground hover:text-primary"
						>
							Read the announcement
						</a>
						.
					</p>
					<p>
						To keep using devflow, self-host the open source version from{' '}
						<a
							href="https://github.com/devflow/devflow"
							target="_blank"
							rel="noopener noreferrer"
							className="underline text-foreground hover:text-primary"
						>
							github.com/devflow/devflow
						</a>
						.
					</p>
				</div>
			</Card>
		</div>
	)
}

function OrganizationCreatePage() {
	const { user } = useAuth()
	const blocked = import.meta.env.VITE_PUBLIC_BLOCK_NEW_ORG_CREATION === 'true'
	if (blocked && !isStaffEmail(user?.email)) {
		return <OrganizationCreationBlocked />
	}
	return (
		<div className="flex flex-col h-full grow items-center justify-center bg-background">
			<Card className="w-md p-6">
				<CardHeader className="flex flex-col gap-2 w-full items-center text-center">
					<Building2 className="mx-auto mb-4 size-12 text-muted-foreground" />
					<p className="text-xl font-semibold">Create Organization</p>
					<p className="text-muted-foreground">Set up a new organization to get started.</p>
				</CardHeader>
				<Separator className="my-4" />
				<OrganizationCreateForm />
			</Card>
		</div>
	)
}
