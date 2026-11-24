import { artifactComments } from '@devflow/db/tables/artifact-comments'
import { and, eq, isNotNull } from 'drizzle-orm'
import { Effect } from 'effect'

import { Directory, formatUserDisplayName } from '../../../../auth/directory'
import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { resolveSharedArtifactAccess } from '../../../../effects/shared-artifacts/resolve-shared-artifact-access'
import { effectOrpcBasePublic } from '../../../effect-base'

export const sharedArtifactCommentAuthorsProcedure = effectOrpcBasePublic.public.artifacts.commentAuthors.effect(
	function* ({ input, errors }) {
		const access = yield* resolveSharedArtifactAccess({
			artifactId: input.artifactId,
			shareKey: input.shareKey,
			viewer: null,
		}).pipe(Effect.catchTag('PostgresDbQueryError', (error) => mapPostgresErrorToResponse(error, errors)))
		if (access.kind !== 'public' || access.permission !== 'comment') return yield* Effect.fail(errors.NOT_FOUND())

		const db = yield* PostgresDb
		const directory = yield* Directory
		const rows = yield* db
			.query(
				db.client
					.selectDistinct({ userId: artifactComments.created_by_user_id })
					.from(artifactComments)
					.where(
						and(
							eq(artifactComments.artifact_id, input.artifactId),
							eq(artifactComments.is_deleted, false),
							eq(artifactComments.created_by_agent, false),
							isNotNull(artifactComments.created_by_user_id),
						),
					),
			)
			.pipe(Effect.catchTag('PostgresDbQueryError', (error) => mapPostgresErrorToResponse(error, errors)))

		const authors = rows.flatMap(({ userId }) => {
			const user = userId ? directory.getUser(userId) : undefined
			if (!user) return []
			return [{ userId: user.id, displayName: formatUserDisplayName(user), avatarUrl: user.profilePictureUrl }]
		})

		return { authors }
	},
)
