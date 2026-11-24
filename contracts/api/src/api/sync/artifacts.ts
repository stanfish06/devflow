import { artifactSelectSchema } from '@devflow/db/tables/artifacts'

import { contractBuilder } from '../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from './shared-schemas'

export const syncArtifactsContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(artifactSelectSchema))
