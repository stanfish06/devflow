import type { ArtifactDeliveryMode } from '@devflow/ui/artifact-viewer-v2'
import { useLocalStorage } from '@uidotdev/usehooks'

export const ARTIFACT_DELIVERY_MODE_KEY = 'devflow-artifact-v2-delivery-mode'

export function useDeliveryPreference(): [ArtifactDeliveryMode, (mode: ArtifactDeliveryMode) => void] {
	const [storedMode, setStoredMode] = useLocalStorage<ArtifactDeliveryMode>(
		ARTIFACT_DELIVERY_MODE_KEY,
		'send-and-resolve',
	)
	const mode: ArtifactDeliveryMode = storedMode === 'send' ? 'send' : 'send-and-resolve'
	return [mode, setStoredMode]
}
