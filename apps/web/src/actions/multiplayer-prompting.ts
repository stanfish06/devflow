import type { ApiInputs } from '@devflow/api-contract/contract-router'

import type { ConfirmTxFn } from '@/components/providers/SyncProvider'
import type { ApiClient } from '@/orpc/client'

export type UpdateMultiplayerPromptingParams = ApiInputs['sessions']['multiplayerPrompting']['update']

export function createMultiplayerPromptingActions(api: Pick<ApiClient, 'sessions'>, sessionsConfirmTx: ConfirmTxFn) {
	const update = async (params: UpdateMultiplayerPromptingParams) => {
		const response = await api.sessions.multiplayerPrompting.update(params)
		await sessionsConfirmTx(response.transactionId)
		return response
	}

	return { update }
}
