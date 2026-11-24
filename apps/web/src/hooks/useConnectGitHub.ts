import { toast } from 'sonner'

import { openExternal } from '@/lib/url-opener'
import { useApi } from '@/orpc/client'

export type ConnectGitHubOutcome = 'started' | 'failed'

/** Opens the GitHub App install flow from any launch surface. */
export function useConnectGitHub() {
	const { client } = useApi()

	return async (): Promise<ConnectGitHubOutcome> => {
		try {
			const { url } = await client.integrations.github.createInstallUrl({})
			await openExternal(url)
			return 'started'
		} catch {
			toast.error('Unable to start the GitHub connection. Open settings to try again.')
			return 'failed'
		}
	}
}
