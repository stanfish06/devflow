import { artifacts } from '@devflow/db/tables/artifacts'
import { ArtifactCommentAnchorSchema } from '@devflow/db/zodschemas/artifact-comment-anchor'
import { CommentKindSchema } from '@devflow/db/zodschemas/artifact-comment-kind'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Schema } from 'effect'

import { getTransactionId } from '../postgres/helpers'
import { PostgresDb } from '../postgres/postgres-db.service'
import {
	ArtifactCommentInvalid,
	ArtifactCommentInvalidInput,
	ArtifactCommentNotFound,
} from './artifact-comments-errors'
import {
	narrowArtifactCommentDatabaseErrors,
	requireTaskReadPermissionForArtifactCommentWrite,
} from './artifact-comments-persistence'
import { CreateArtifactCommentInput } from './artifact-comments-types'
import { recordFirstInboundReviewComment } from './first-inbound-comment'
import { insertThreadComment } from './insert-thread-comment'

/** Creates a root or root-normalized reply. */
export const createArtifactComment = Effect.fn('artifact_comments.create')(function* (rawInput: unknown) {
	const decodedInput = yield* Schema.decodeUnknownEffect(CreateArtifactCommentInput)(rawInput).pipe(
		Effect.mapError(() => new ArtifactCommentInvalidInput({ message: 'Invalid artifact comment input' })),
	)
	const anchor =
		decodedInput.anchorJson === undefined
			? undefined
			: ArtifactCommentAnchorSchema.safeParse(decodedInput.anchorJson)
	if (anchor && !anchor.success)
		return yield* Effect.fail(new ArtifactCommentInvalidInput({ message: 'Invalid artifact comment anchor' }))
	const kind = decodedInput.kind === undefined ? undefined : CommentKindSchema.safeParse(decodedInput.kind)
	if (kind && !kind.success)
		return yield* Effect.fail(new ArtifactCommentInvalidInput({ message: 'Invalid artifact comment kind' }))
	const input = {
		...decodedInput,
	}
	const postgres = yield* PostgresDb
	const now = BigInt(yield* Clock.currentTimeMillis)
	const result = yield* postgres
		.transaction((tx) =>
			Effect.gen(function* () {
				const found = yield* tx
					.query(tx.client.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1))
					.pipe(Effect.map((rows) => rows[0]))
				if (!found) return yield* Effect.fail(new ArtifactCommentNotFound({ message: 'Artifact not found' }))
				if (!found.task_id) {
					if (found.organization_id !== input.userInfo.organizationId)
						return yield* Effect.fail(new ArtifactCommentNotFound({ message: 'Artifact not found' }))
					return yield* Effect.fail(
						new ArtifactCommentInvalid({ message: 'Artifact has no associated task' }),
					)
				}
				const task = yield* requireTaskReadPermissionForArtifactCommentWrite(
					tx,
					{ taskId: found.task_id, userInfo: input.userInfo },
					'Artifact not found',
				)
				const resourceOwnerUserId = task.resource_owner_user_id ?? found.resource_owner_user_id
				const { commentId } = yield* insertThreadComment(tx, {
					artifact: { ...found, task_id: found.task_id, resource_owner_user_id: resourceOwnerUserId },
					author: {
						kind: 'user',
						userId: input.userInfo.userId,
						createdByAgent: input.userInfo.createdByAgent,
					},
					id: input.id,
					contentText: input.contentText,
					contentJson: input.contentJson,
					commentedUponBlockText: input.commentedUponBlockText,
					previousBlockText: input.previousBlockText,
					nextBlockText: input.nextBlockText,
					anchorJson: anchor?.data,
					kind: kind?.data,
					replyToCommentId: input.replyToCommentId,
					now,
				})
				yield* recordFirstInboundReviewComment(tx, {
					ownerUserId: found.resource_owner_user_id,
					organizationId: found.organization_id,
					commenterUserId: input.userInfo.userId,
					createdByAgent: input.userInfo.createdByAgent,
					frontmatterType:
						typeof found.frontmatter?.type === 'string' ? (found.frontmatter.type as string) : undefined,
					fileName: found.file_name,
					now,
				})
				return {
					success: true as const,
					commentId,
					transactionId: yield* getTransactionId(tx),
					postCommitContext: {
						ownerUserId: resourceOwnerUserId,
						taskId: found.task_id,
						taskSlug: task.slug ?? null,
						artifactId: found.id,
						artifactFileName: found.file_name,
					},
				}
			}),
		)
		.pipe(narrowArtifactCommentDatabaseErrors)

	return result
})
