import { useCallback } from 'react'

import {
	useArtifactSharingDialogStore,
	type ArtifactSharingDialogTarget,
} from '@/hooks/stores/artifactSharingDialogStore'

export function useArtifactSharingDialog() {
	const openDialog = useArtifactSharingDialogStore((state) => state.openDialog)
	const openSharingDialog = useCallback((target: ArtifactSharingDialogTarget) => openDialog(target), [openDialog])
	return { openSharingDialog }
}
