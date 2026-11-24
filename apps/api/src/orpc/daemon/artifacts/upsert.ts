import { checkIfDesignDocHasOpenQuestions } from '@devflow/ai/design-doc-open-questions'
import { artifactOperationsLog } from '@devflow/db/tables/artifact-operations-log'
import { artifactVersions } from '@devflow/db/tables/artifact-versions'
import { artifacts } from '@devflow/db/tables/artifacts'
import { sessions } from '@devflow/db/tables/sessions'
import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { hash } from 'ohash'

import { getTxId } from '../../../db/get-tx-id'
import { getTaskWithEffectivePermissions } from '../../../db/task-auth'
import { MAX_TEXT_CONTENT_BYTES } from '../../../lib/constants'
import { normalizeSubpath } from '../../../lib/normalize-subpath'
import { stripNullBytes } from '../../../lib/strip-null-bytes'
import logger from '../../../logger'
import { daemonBase } from '../../base'

const DESIGN_QUESTION_RESOLUTION_DOCUMENT_TYPES: readonly string[] = ['design-discussion']

export const upsertArtifactProcedure = daemonBase.artifacts.upsert.handler(async ({ input, context, errors }) => {
	const { id: clientId, taskId, fileName: rawFileName, sessionId, operationType } = input
	// Postgres rejects U+0000 in text and jsonb. Strip before hashing so content_hash
	// matches the stored content (see lib/strip-null-bytes.ts).
	const content = stripNullBytes(input.content)
	const operationContents = stripNullBytes(input.operationContents)
	const frontmatter = stripNullBytes(input.frontmatter)
	const fileName = normalizeSubpath(rawFileName)
	const { organizationId, userId } = context.auth
	const { services } = context
	const { db } = services

	// Validate content size (UTF-8 byte length) - handles multi-byte characters
	const contentBytes = Buffer.byteLength(content, 'utf8')
	if (contentBytes > MAX_TEXT_CONTENT_BYTES) {
		throw errors.BAD_REQUEST({
			data: { message: `Content size (${Math.round(contentBytes / 1024 / 1024)}MB) exceeds maximum of 10MB` },
		})
	}

	// Compute content hash server-side using ohash
	const contentHash = hash(content)

	try {
		const txResult = await db.transaction(async (tx) => {
			// 1. Lookup task and verify access via ownership OR ACL with effective permissions
			const task = await getTaskWithEffectivePermissions(tx, taskId, userId, organizationId, {
				lockForUpdate: true,
			})

			if (!task) {
				throw errors.NOT_FOUND()
			}

			// 2. Require edit permission to upsert artifacts
			if (task.effectivePermission !== 'edit') {
				throw errors.FORBIDDEN({ message: 'Edit permission required to create or update artifacts' })
			}

			const taskSlug = task.slug
			const resourceOwnerUserId = task.resource_owner_user_id ?? userId

			// 3. Check if artifact exists
			const [existingArtifact] = await tx
				.select()
				.from(artifacts)
				.where(and(eq(artifacts.task_id, taskId), eq(artifacts.file_name, fileName)))
				.limit(1)

			let artifactId: string
			let created = false
			let versionNumber: number | undefined

			if (existingArtifact) {
				// UPDATE existing artifact
				artifactId = existingArtifact.id

				// Only create version if content changed
				if (existingArtifact.content_hash !== contentHash) {
					// Get next version number
					const [maxVersion] = await tx
						.select({ max: sql<number>`MAX(version_number)` })
						.from(artifactVersions)
						.where(eq(artifactVersions.artifact_id, artifactId))

					versionNumber = (maxVersion?.max ?? 0) + 1

					// Create version with previous content
					await tx.insert(artifactVersions).values({
						artifact_id: artifactId,
						task_id: taskId,
						task_slug: taskSlug,
						resource_owner_user_id: resourceOwnerUserId,
						organization_id: organizationId,
						content: existingArtifact.content ?? '',
						content_hash: existingArtifact.content_hash ?? '',
						created_by: userId,
						version_number: versionNumber,
					})
				}

				// Update artifact
				await tx
					.update(artifacts)
					.set({
						content,
						content_hash: contentHash,
						task_slug: taskSlug,
						frontmatter: frontmatter ?? {},
						last_updated_at: BigInt(Date.now()),
						is_deleted: false,
						// Reset S3 fields — text upsert always means postgres storage
						storage_type: 'postgres',
						s3_key: null,
						content_type: null,
						file_size_bytes: null,
					})
					.where(eq(artifacts.id, artifactId))
			} else {
				// CREATE new artifact (use client-provided ID if given)
				const newArtifactValues: typeof artifacts.$inferInsert = {
					task_id: taskId,
					task_slug: taskSlug,
					file_name: fileName,
					content,
					content_hash: contentHash,
					frontmatter: frontmatter ?? {},
					resource_owner_user_id: resourceOwnerUserId,
					organization_id: organizationId,
					created_by: userId,
				}
				if (clientId) newArtifactValues.id = clientId
				const [newArtifact] = await tx.insert(artifacts).values(newArtifactValues).returning()

				if (!newArtifact) throw new Error('insert returned no row')
				artifactId = newArtifact.id
				created = true
			}

			// Log operation if operationType and operationContents provided
			if (operationType && operationContents) {
				await tx.insert(artifactOperationsLog).values({
					artifact_id: artifactId,
					session_id: sessionId ?? null,
					task_id: taskId,
					task_slug: taskSlug,
					resource_owner_user_id: resourceOwnerUserId,
					organization_id: organizationId,
					created_by: userId,
					operation_type: operationType,
					operation_contents: operationContents,
					version_created: versionNumber !== undefined,
				})
			}

			const txid = await getTxId(tx)
			return { artifactId, txid, created, versionNumber, resourceOwnerUserId, taskSlug }
		})

		const output = {
			artifactId: txResult.artifactId,
			transactionId: txResult.txid,
			created: txResult.created,
			versionNumber: txResult.versionNumber,
		}

		const documentType = frontmatter?.type as string | undefined
		if (!documentType || !DESIGN_QUESTION_RESOLUTION_DOCUMENT_TYPES.includes(documentType)) {
			return output
		}

		if (!sessionId) {
			return output
		}

		const [designSession] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.organization_id, organizationId),
					sql`(
						${sessions.labels} @> '[{"name":"rpi:design"}]'::jsonb
						OR ${sessions.labels} @> '[{"name":"rpi:design-prd"}]'::jsonb
						OR ${sessions.labels} @> '[{"name":"rpi:design-tdd"}]'::jsonb
					)`,
				),
			)
			.limit(1)

		if (!designSession) {
			return output
		}

		try {
			const questionCount = await Effect.runPromise(checkIfDesignDocHasOpenQuestions(content))
			return {
				...output,
				designQuestionsResolved: questionCount.numOpenQuestions === 0,
			}
		} catch (error) {
			logger.error({ error, artifactId: txResult.artifactId, taskId }, 'Design question inference failed')

			return output
		}
	} catch (error: unknown) {
		logger.error(error, 'Failed to upsert artifact')
		throw error
	}
})
