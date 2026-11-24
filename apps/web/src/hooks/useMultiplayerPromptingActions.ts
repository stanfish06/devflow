import { useMemo } from 'react'

import { createMultiplayerPromptingActions } from '@/actions/multiplayer-prompting'
import { useSyncInternal } from '@/components/providers/SyncProvider'
import { useApi } from '@/orpc/client'

export function useMultiplayerPromptingActions() {
	const { client } = useApi()
	const { confirmTx } = useSyncInternal()

	return useMemo(() => createMultiplayerPromptingActions(client, confirmTx.sessions), [client, confirmTx.sessions])
}
