import { sql } from 'drizzle-orm'
import { bigint, check, customType, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { uuidv7 } from 'uuidv7'

import { organizations } from './organizations'

export const GITHUB_ACCOUNT_STATUSES = ['ok', 'needs_token'] as const
/** `needs_token`: GitHub rejected the stored token; the account stays until it is replaced or removed. */
export type GithubAccountStatus = (typeof GITHUB_ACCOUNT_STATUSES)[number]

// postgres-js sends a Uint8Array parameter as bytea and reads bytea back as a Buffer (a Uint8Array).
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
	dataType: () => 'bytea',
	toDriver: (value) => value,
	fromDriver: (value) => new Uint8Array(value),
})

/**
 * A GitHub account a user's agents can push and open pull requests as, on any of their hosts.
 *
 * Personal: one row per (organization, user, GitHub user), never shared with teammates. The
 * personal access token is stored only encrypted (AES-256-GCM with the server's
 * `GITHUB_ACCOUNT_TOKEN_KEY`, the GCM tag appended to the ciphertext). Not an Electric shape, so
 * neither the token nor the row reaches a browser through sync.
 */
export const githubAccounts = pgTable(
	'github_accounts',
	{
		id: uuid()
			.primaryKey()
			.default(sql`uuidv7()`)
			.$defaultFn(() => uuidv7()),
		organization_id: uuid('organization_id')
			.references(() => organizations.id, { onDelete: 'cascade' })
			.notNull(),
		user_id: text('user_id').notNull(),
		// GitHub's numeric user id: stable across renames, so it identifies the account.
		github_user_id: bigint('github_user_id', { mode: 'number' }).notNull(),
		login: text('login').notNull(),
		// GitHub display name, the commit author name; null when the profile has none.
		name: text('name'),
		// `{id}+{login}@users.noreply.github.com`, the commit author email.
		noreply_email: text('noreply_email').notNull(),
		token_iv: bytea('token_iv').notNull(),
		token_ciphertext: bytea('token_ciphertext').notNull(),
		status: text('status').$type<GithubAccountStatus>().notNull().default('ok'),
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
	(t) => [
		uniqueIndex('github_accounts_org_user_github_user_idx').on(t.organization_id, t.user_id, t.github_user_id),
		check('github_accounts_status_check', sql`${t.status} IN ('ok', 'needs_token')`),
	],
)

export type GithubAccountRow = typeof githubAccounts.$inferSelect
export type NewGithubAccountRow = typeof githubAccounts.$inferInsert
