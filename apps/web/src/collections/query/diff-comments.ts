import { diffCommentSelectSchema } from '@devflow/db/tables/diff-comments'
import { type CollectionHealthTracker, createBrowserQueryCollection } from '@devflow/sync'
import type { QueryClient } from '@tanstack/query-core'

import type { ApiClient } from '@/orpc/client'

const queryDiffCommentsCollectionBuilder = createBrowserQueryCollection({
	collectionName: 'diffComments',
	rowSchema: diffCommentSelectSchema,
	procedure: (apiClient) => {
		const client = apiClient as ApiClient
		return client.sync.v2.diffComments
	},
	bigIntFields: ['created_at', 'updated_at'],
})

export const createQueryDiffCommentsCollection = queryDiffCommentsCollectionBuilder.create
export type QueryDiffCommentsCollection = ReturnType<typeof createQueryDiffCommentsCollection>

export const getQueryDiffCommentsCollection = (
	userId: string | null,
	organizationId: string | null,
	apiClient: ApiClient,
	tracker: CollectionHealthTracker,
	queryClient: QueryClient,
) =>
	queryDiffCommentsCollectionBuilder.get(userId, organizationId, {
		apiClient,
		tracker,
		queryClient,
		syncVersion: 2,
	})

export const destroyQueryDiffCommentsCollection = (userId: string | null, organizationId: string | null) =>
	queryDiffCommentsCollectionBuilder.destroy(userId, organizationId, 2)
