import type { FC } from 'react'

import { useConnectGitHub } from '@/hooks/useConnectGitHub'
import { openCloudUrl } from '@/lib/url-opener'
import { getOrgSettingsUrl } from '@/utils/artifact-links'

import { type GitHubConnectReason, GitHubConnectPrompt } from './GitHubConnectPrompt'

const openOrgSettings = (event: React.MouseEvent) => {
	event.preventDefault()
	openCloudUrl(getOrgSettingsUrl())
}

export const WiredGitHubConnectPrompt: FC<{
	reason: GitHubConnectReason
	isAdmin: boolean
	repositories?: readonly string[]
}> = ({ reason, isAdmin, repositories }) => {
	const connect = useConnectGitHub()
	const openSettings = () => openCloudUrl(getOrgSettingsUrl())
	const onAction = reason === 'repositories_without_app' ? openSettings : () => void connect()
	return (
		<GitHubConnectPrompt
			reason={reason}
			isAdmin={isAdmin}
			settingsUrl={getOrgSettingsUrl()}
			repositories={repositories}
			onOpenExternal={openOrgSettings}
			onAction={onAction}
		/>
	)
}
