import { createFileRoute } from '@tanstack/react-router'

import { useMountEffect } from '@/hooks/useMountEffect'
import { useAuth } from '@/integrations/devflow/local-authkit'

export const Route = createFileRoute('/_app/auth/signout')({
	component: RouteComponent,
})

function RouteComponent() {
	const { signOut } = useAuth()
	useMountEffect(() => {
		signOut({ returnTo: window.location.origin })
	})
	return null
}
