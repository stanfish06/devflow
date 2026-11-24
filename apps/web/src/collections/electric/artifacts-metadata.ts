import { artifactMetadataSelectSchema } from '@devflow/db/tables/artifacts'
import { type CollectionHealthTracker, createBrowserElectricCollection, type SyncVersion } from '@devflow/sync'
import { BTreeIndex } from '@tanstack/db'

import { VITE_PUBLIC_SYNC_ORIGIN } from '@/collections/config'
import { logger } from '@/lib/logger'

const artifactsMetadataCollectionBuilder = createBrowserElectricCollection({
	schema: artifactMetadataSelectSchema,
	routePath: '/artifacts/metadata',
	collectionName: 'artifactsMetadata',
	indexes: [{ field: (row) => row.last_updated_at, name: 'last_updated_at', indexType: BTreeIndex }],
})

export const createArtifactsMetadataCollection = artifactsMetadataCollectionBuilder.create

export type ArtifactsMetadataCollection = ReturnType<typeof createArtifactsMetadataCollection>

export const getArtifactsMetadataCollection = (
	userId: string | null,
	organizationId: string | null,
	tokenFetcher: () => Promise<string>,
	isLoading: boolean,
	tracker: CollectionHealthTracker,
	syncVersion: SyncVersion = 2,
) =>
	artifactsMetadataCollectionBuilder.get(
		userId,
		organizationId,
		{
			syncOrigin: VITE_PUBLIC_SYNC_ORIGIN,
			tokenFetcher,
			shouldRetryOnFailure: !isLoading,
			tracker,
			syncVersion,
			logger,
		},
		isLoading,
	)
