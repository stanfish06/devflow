import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createElectricTestContext, createTestUser, type ElectricTestContext, waitForItem } from './fixtures'

const CI = Boolean(process.env.CI)

/**
 * The daemon's task-user-settings shape carries the GitHub account its own user picked per task, so
 * it must never include a teammate's rows (unlike the org-wide /v2/task-user-settings).
 */
describe.skipIf(CI)('/v2/daemon/task-user-settings', () => {
	let ctx: ElectricTestContext

	beforeAll(async () => {
		ctx = await createElectricTestContext()
	})

	afterAll(async () => {
		await ctx.shutdown()
	})

	test("exposes only the daemon user's own rows in its organization", async () => {
		const owner = createTestUser(`daemon-tus-owner-${randomUUID()}`)
		const teammate = createTestUser(`daemon-tus-teammate-${randomUUID()}`)
		const otherOrganization = await ctx.seedOrganization({ name: `Daemon TUS Other Org ${randomUUID()}` })
		const server = ctx.createProxyServer({
			user: owner,
			organization: ctx.defaultOrganization,
			hostId: randomUUID(),
			key: `daemon-tus-${randomUUID()}`,
		})
		const collection = await ctx.createDaemonTaskUserSettingsCollection({ server })
		const task = await ctx.seedTask({
			organization_id: ctx.defaultOrganization.id,
			name: 'Daemon task user settings scope',
			created_by: owner.userId,
			resource_owner_user_id: owner.userId,
		})
		const mine = await ctx.seedTaskUserSettings({
			task_id: task.id,
			user_id: owner.userId,
			organization_id: ctx.defaultOrganization.id,
			github_use_host_login: true,
		})
		const teammates = await ctx.seedTaskUserSettings({
			task_id: task.id,
			user_id: teammate.userId,
			organization_id: ctx.defaultOrganization.id,
			github_use_host_login: true,
		})
		const otherOrganizationTask = await ctx.seedTask({
			organization_id: otherOrganization.id,
			name: 'Daemon task user settings organization scope',
			created_by: owner.userId,
			resource_owner_user_id: owner.userId,
		})
		const otherOrganizationRow = await ctx.seedTaskUserSettings({
			task_id: otherOrganizationTask.id,
			user_id: owner.userId,
			organization_id: otherOrganization.id,
			github_use_host_login: true,
		})

		await waitForItem(collection, mine.id, { timeout: 10_000 })
		await sleep(1_000)
		expect(collection.has(mine.id)).toBe(true)
		expect(collection.has(teammates.id)).toBe(false)
		expect(collection.has(otherOrganizationRow.id)).toBe(false)
	})

	test('refuses a token without a host', async () => {
		const owner = createTestUser(`daemon-tus-browser-${randomUUID()}`)
		const server = ctx.createProxyServer({
			user: owner,
			organization: ctx.defaultOrganization,
			key: `daemon-tus-browser-${randomUUID()}`,
		})
		const response = await fetch(`http://localhost:${server.port}/v2/daemon/task-user-settings?offset=-1`)
		expect(response.status).toBe(400)
	})
})
