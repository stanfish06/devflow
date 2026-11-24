import { artifactMetadataSelectSchema } from '@devflow/db/tables/artifacts'

import { contractBuilder } from '../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from './shared-schemas'

export const syncArtifactsMetadataContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(artifactMetadataSelectSchema))
