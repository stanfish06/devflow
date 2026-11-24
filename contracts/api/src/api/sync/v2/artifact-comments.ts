import { artifactCommentSelectSchema } from '@devflow/db/tables/artifact-comments'

import { contractBuilder } from '../../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from '../shared-schemas'

export const syncV2ArtifactCommentsContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(artifactCommentSelectSchema))
