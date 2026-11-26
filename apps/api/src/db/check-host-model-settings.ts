import { isEffortSupported, isFastModeSupported } from '@devflow/ai/config'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import type { CodingAgent } from '@devflow/schemas/coding-agent'
import { findHostModelCatalogEntry } from '@devflow/schemas/zod/model-catalog'
import { and, eq } from 'drizzle-orm'

import type { PostgresDbClient } from '../effects/services/postgres/postgres-db.service'

interface ModelSettings {
	hostId?: string | null
	codingAgent?: CodingAgent | null
	provider?: string | null
	model?: string | null
	effort?: string | null
	fastMode?: boolean | null
}

/** The picker's Codex capabilities come from the host's model/list response. */
export async function checkHostModelSettings(
	db: PostgresDbClient,
	owner: { organizationId: string; userId: string },
	settings: ModelSettings,
) {
	const { codingAgent, provider, model, effort, fastMode } = settings
	const catalogEntry = await getCodexHostModel(db, owner, settings)
	return {
		effortSupported: isEffortSupported(codingAgent, provider, model, effort, catalogEntry),
		fastModeSupported: isFastModeSupported(codingAgent, provider, model, fastMode, catalogEntry),
	}
}

async function getCodexHostModel(
	db: PostgresDbClient,
	owner: { organizationId: string; userId: string },
	settings: ModelSettings,
) {
	if (
		settings.provider !== 'codex' ||
		(settings.codingAgent !== 'codelayer' && settings.codingAgent !== 'fold') ||
		!settings.hostId ||
		!settings.model ||
		((settings.effort === null || settings.effort === undefined) && !settings.fastMode)
	) {
		return null
	}

	const [host] = await db
		.select({ catalog: onlineHosts.supported_models })
		.from(onlineHosts)
		.where(
			and(
				eq(onlineHosts.host_id, settings.hostId),
				eq(onlineHosts.organization_id, owner.organizationId),
				eq(onlineHosts.user_id, owner.userId),
			),
		)
		.limit(1)

	return findHostModelCatalogEntry(host?.catalog, 'codex', settings.model)
}
