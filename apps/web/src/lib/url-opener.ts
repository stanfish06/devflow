import { toast } from 'sonner'

/** Opens a URL in a new browser tab. */
export async function openExternal(url: string): Promise<void> {
	window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Open a devflow-cloud URL, or say why not when the build has no cloud origin (see getCloudOrigin).
 */
export function openCloudUrl(url: string | undefined): void {
	if (!url) {
		toast.error('Could not open devflow Cloud', {
			description: 'This build has no cloud address. Set VITE_PUBLIC_CLOUD_ORIGIN and rebuild.',
		})
		return
	}
	void openExternal(url)
}
