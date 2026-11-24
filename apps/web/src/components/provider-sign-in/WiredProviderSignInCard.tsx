import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { useProviderSignIn } from '@/hooks/useProviderSignIn'
import { openExternal } from '@/lib/url-opener'

import { ProviderSignInCard, type ProviderSignInProvider } from './ProviderSignInCard'

interface WiredProviderSignInCardProps {
	hostId: string | null
	provider: ProviderSignInProvider
	variant: 'card' | 'inline'
	/** Fires once when a sign-in started while this card was mounted succeeds. */
	onSignedIn?: () => void
	children?: ReactNode
}

export function WiredProviderSignInCard({
	hostId,
	provider,
	variant,
	onSignedIn,
	children,
}: WiredProviderSignInCardProps) {
	const navigate = useNavigate()
	const { host, request, start, cancel, submitCode, isStarting } = useProviderSignIn(hostId, provider, onSignedIn)

	return (
		<ProviderSignInCard
			provider={provider}
			request={request}
			variant={variant}
			host={host}
			isStarting={isStarting}
			onSignIn={start}
			onCancel={cancel}
			onSubmitCode={submitCode}
			onOpenUrl={(url) => void openExternal(url)}
			onOpenDaemonSettings={() => void navigate({ to: '/settings/daemons' })}
		>
			{children}
		</ProviderSignInCard>
	)
}
