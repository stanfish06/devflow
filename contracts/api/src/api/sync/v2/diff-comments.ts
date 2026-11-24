import { diffCommentSelectSchema } from '@devflow/db/tables/diff-comments'

import { contractBuilder } from '../../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from '../shared-schemas'

export const syncV2DiffCommentsContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(diffCommentSelectSchema))
