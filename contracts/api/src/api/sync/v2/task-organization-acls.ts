import { taskOrganizationAclSelectSchema } from '@devflow/db/tables/task-organization-acl'

import { contractBuilder } from '../../../contract-builder'
import { createSyncOutputSchema, SyncInputSchema } from '../shared-schemas'

export const syncV2TaskOrganizationAclsContract = contractBuilder
	.input(SyncInputSchema)
	.output(createSyncOutputSchema(taskOrganizationAclSelectSchema))
