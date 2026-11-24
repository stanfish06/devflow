import type { ProviderSignInRequest } from '@/components/provider-sign-in/ProviderSignInCard'
import { isSignInActive } from '@/hooks/useProviderSignIn'

import type { SignInStatusTone } from './SignInHost'

export function signInStatusTone(request: ProviderSignInRequest | null, isSignedIn: boolean): SignInStatusTone {
	if (isSignedIn) return 'ready'
	return isSignInActive(request) ? 'active' : 'idle'
}
