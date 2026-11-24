import { userSettings } from '@devflow/db/tables/user-settings'
import { isNull } from 'drizzle-orm'
import { Effect } from 'effect'

import type { PostgresDbQueryError } from '../postgres/postgres-db.errors'
import type { PostgresTransaction } from '../postgres/postgres-db.service'

type PlanningArtifactIdentity = {
	readonly frontmatterType?: string | null
	readonly fileName?: string | null
}

export type RecordFirstInboundReviewCommentInput = PlanningArtifactIdentity & {
	readonly ownerUserId: string
	readonly commenterUserId: string
	readonly organizationId: string
	readonly createdByAgent: boolean
	readonly now: bigint
}

/** Frontmatter types of the artifacts a teammate reviews: design discussion, PRD, TDD. */
const DESIGN_REVIEW_FRONTMATTER_TYPES: ReadonlySet<string> = new Set(['design-discussion', 'design-prd', 'design-tdd'])

/** Frontmatter type first, filename as a fallback for artifacts written without frontmatter. */
function isDesignReviewArtifact(input: PlanningArtifactIdentity): boolean {
	if (input.frontmatterType && DESIGN_REVIEW_FRONTMATTER_TYPES.has(input.frontmatterType)) return true
	const fileName = input.fileName?.toLowerCase() ?? ''
	return fileName.includes('design-discussion') || fileName.includes('prd') || fileName.includes('tdd')
}

function isStructureOutlineArtifact(input: PlanningArtifactIdentity): boolean {
	if (input.frontmatterType === 'structure-outline') return true
	return input.fileName?.toLowerCase().includes('structure-outline') ?? false
}

/**
 * Sets the owner's getting-started milestone `user_settings.first_inbound_comment_received_at`
 * inside the comment-creation transaction. Only another user's comment (human or agent) on the
 * owner's planning artifact counts; the `is null` guard keeps the first timestamp.
 */
export function recordFirstInboundReviewComment(
	tx: PostgresTransaction,
	input: RecordFirstInboundReviewCommentInput,
): Effect.Effect<void, PostgresDbQueryError> {
	const isPlanningArtifact = isDesignReviewArtifact(input) || isStructureOutlineArtifact(input)
	if (input.ownerUserId === input.commenterUserId || !isPlanningArtifact) return Effect.void
	return tx
		.query(
			tx.client
				.insert(userSettings)
				.values({
					user_id: input.ownerUserId,
					organization_id: input.organizationId,
					first_inbound_comment_received_at: input.now,
				})
				.onConflictDoUpdate({
					target: [userSettings.user_id, userSettings.organization_id],
					set: { first_inbound_comment_received_at: input.now, updated_at: input.now },
					where: isNull(userSettings.first_inbound_comment_received_at),
				}),
		)
		.pipe(Effect.asVoid)
}
