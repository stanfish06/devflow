import { sql } from 'drizzle-orm'
import { bigint, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'

import { githubAccounts } from './github-accounts'
import { organizations } from './organizations'
import { projects } from './projects'

/**
 * One person's own preferences for a project. Projects are shared, but GitHub accounts are
 * personal, so each member of a project keeps their own row. Not an Electric shape: browsers read
 * it through `githubAccounts.list`.
 */
export const projectUserSettings = pgTable(
	'project_user_settings',
	{
		organization_id: uuid('organization_id')
			.references(() => organizations.id, { onDelete: 'cascade' })
			.notNull(),
		user_id: text('user_id').notNull(),
		project_id: uuid('project_id')
			.references(() => projects.id, { onDelete: 'cascade' })
			.notNull(),
		// The GitHub account this user's agents act as in the project's tasks, unless a task picks its
		// own. Null: no project default, so the user's own default applies. Written only by
		// projects.v2.setGithubAccount, which checks the account is the user's own; removing the
		// account clears it.
		github_account_id: uuid('github_account_id').references(() => githubAccounts.id, { onDelete: 'set null' }),
		created_at: bigint('created_at', { mode: 'bigint' })
			.notNull()
			.default(sql`(extract(epoch from now()) * 1000)::bigint`)
			.$defaultFn(() => BigInt(Date.now())),
		updated_at: bigint('updated_at', { mode: 'bigint' })
			.notNull()
			.default(sql`(extract(epoch from now()) * 1000)::bigint`)
			.$defaultFn(() => BigInt(Date.now()))
			.$onUpdateFn(() => BigInt(Date.now())),
	},
	(t) => [primaryKey({ name: 'project_user_settings_pk', columns: [t.organization_id, t.user_id, t.project_id] })],
)

export type ProjectUserSettings = typeof projectUserSettings.$inferSelect
export type NewProjectUserSettings = typeof projectUserSettings.$inferInsert
