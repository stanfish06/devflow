import { HotkeysProvider } from '@devflow/hotkeys'
import type { PropsWithChildren } from 'react'

export function SharedArtifactProviders({ children }: PropsWithChildren) {
	return <HotkeysProvider initiallyActiveScopes={['*', '.']}>{children}</HotkeysProvider>
}
