import { useAuth } from '@/integrations/devflow/local-authkit'

/** The auth context plus `switchOrganization`, the name callers use for an org switch. */
export function useBrowserAuth() {
	const auth = useAuth()
	return { ...auth, switchOrganization: auth.switchToOrganization }
}
