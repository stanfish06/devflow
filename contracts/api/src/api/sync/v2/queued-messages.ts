import { queuedMessageSelectSchema } from '@devflow/db/tables/queued-messages'

import { contractBuilder } from '../../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from '../shared-schemas'

export const syncV2QueuedMessagesContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(queuedMessageSelectSchema))
