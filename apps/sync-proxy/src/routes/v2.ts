import { agentCommandDiscoveryRequests } from '@devflow/db/tables/agent-command-discovery-requests'
import { approvals } from '@devflow/db/tables/approvals'
import { artifactComments } from '@devflow/db/tables/artifact-comments'
import { artifacts } from '@devflow/db/tables/artifacts'
import { conversationEvents } from '@devflow/db/tables/conversation-events'
import { diffComments } from '@devflow/db/tables/diff-comments'
import { onlineHosts } from '@devflow/db/tables/online-hosts'
import { providerLoginRequests } from '@devflow/db/tables/provider-login-requests'
import { queuedMessages } from '@devflow/db/tables/queued-messages'
import { sessions } from '@devflow/db/tables/sessions'
import { taskOrganizationAcl } from '@devflow/db/tables/task-organization-acl'
import { taskUserAcl } from '@devflow/db/tables/task-user-acl'
import { taskUserSettings } from '@devflow/db/tables/task-user-settings'
import { taskWorkspaceSetupForHost } from '@devflow/db/tables/task-workspace-setup-for-host'
import { tasks } from '@devflow/db/tables/tasks'
import { workspaceRepositoryStatusForUserForHost } from '@devflow/db/tables/workspace-repository-status-for-user-for-host'
import { getTableName } from 'drizzle-orm'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { StatusCodes } from 'http-status-codes'

import type { AppConfig } from '../app-config'
import { ElectricProxy } from '../lib/effect/electric-proxy.service'
import type { ElectricRequestContext } from '../lib/electric-error-handler'
import {
	buildArtifactMetadataColumns,
	buildWhereFragmentForOrgScopedRows,
	buildWhereFragmentForOrgScopedTaskArtifacts,
	buildWhereFragmentForOrgScopedTasks,
} from '../lib/v2-where-builder'
import { isUuid } from '../lib/validation'
import { applyWhereToUrl, buildWhereFragment } from '../lib/where-builder'
import { createAuthMiddleware } from '../middleware'
import { createElectricOriginMiddleware } from './electric-origin'

function proxyElectricResponseWithRuntime(
	config: AppConfig,
	url: URL,
	context?: Omit<ElectricRequestContext, 'electricUrl'>,
	incomingRequest?: { method: string; text: () => Promise<string> },
) {
	return config.effectRuntime.runPromise(
		Effect.gen(function* () {
			const proxy = yield* ElectricProxy
			return yield* proxy.proxyShapeRequest(url, context, incomingRequest)
		}),
	)
}

export function createV2App(config: AppConfig) {
	const app = new Hono()

	app.use(createAuthMiddleware(config))
	app.use(createElectricOriginMiddleware(config))

	app.all('/sessions', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(sessions))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(sessions, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/tasks', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(tasks))
		const { fragment, params } = buildWhereFragmentForOrgScopedTasks(c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/events', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(conversationEvents))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(conversationEvents, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/approvals', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(approvals))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(approvals, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/artifact-comments', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(artifactComments))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(artifactComments, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/diff-comments', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(diffComments))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(diffComments, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/artifacts', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(artifacts))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(artifacts, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/artifacts/metadata', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(artifacts))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(artifacts, c.var.authContext)
		c.var.electricOriginUrl.searchParams.set('columns', buildArtifactMetadataColumns())
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/hosts', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(onlineHosts))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(onlineHosts, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/queued-messages', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(queuedMessages))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(queuedMessages, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/task-organization-acls', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskOrganizationAcl))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(taskOrganizationAcl, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/task-user-acls', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskUserAcl))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(taskUserAcl, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/task-user-settings', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskUserSettings))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(taskUserSettings, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/task-workspace-setup-for-host', async (c) => {
		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskWorkspaceSetupForHost))
		const { fragment, params } = buildWhereFragmentForOrgScopedRows(taskWorkspaceSetupForHost, c.var.authContext)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/provider-login-requests', async (c) => {
		const { organizationId, userId } = c.var.authContext
		c.var.electricOriginUrl.searchParams.set('table', getTableName(providerLoginRequests))
		const { fragment, params } = buildWhereFragment(providerLoginRequests, [
			{ column: providerLoginRequests.organization_id, value: organizationId },
			{ column: providerLoginRequests.user_id, value: userId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/daemon/workspace-repository-statuses', async (c) => {
		const { organizationId, userId, hostId } = c.var.authContext
		if (!hostId) return c.json({ error: 'hostId required in daemon token' }, StatusCodes.BAD_REQUEST)
		const table = workspaceRepositoryStatusForUserForHost
		c.var.electricOriginUrl.searchParams.set('table', getTableName(table))
		const { fragment, params } = buildWhereFragment(table, [
			{ column: table.organization_id, value: organizationId },
			{ column: table.user_id, value: userId },
			{ column: table.host_id, value: hostId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	// A daemon's own user's per-task choices (the GitHub account its agents act as), so it can follow
	// a mid-run switch. Unlike /task-user-settings, never a teammate's row.
	app.all('/daemon/task-user-settings', async (c) => {
		const { organizationId, userId, hostId } = c.var.authContext
		if (!hostId) return c.json({ error: 'hostId required in daemon token' }, StatusCodes.BAD_REQUEST)

		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskUserSettings))
		const { fragment, params } = buildWhereFragment(taskUserSettings, [
			{ column: taskUserSettings.organization_id, value: organizationId },
			{ column: taskUserSettings.user_id, value: userId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/daemon/provider-login-requests', async (c) => {
		const { organizationId, hostId } = c.var.authContext
		if (!hostId) return c.json({ error: 'hostId required in daemon token' }, StatusCodes.BAD_REQUEST)

		c.var.electricOriginUrl.searchParams.set('table', getTableName(providerLoginRequests))
		const { fragment, params } = buildWhereFragment(providerLoginRequests, [
			{ column: providerLoginRequests.organization_id, value: organizationId },
			{ column: providerLoginRequests.host_id, value: hostId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/daemon/agent-command-discovery-requests', async (c) => {
		const { organizationId, hostId } = c.var.authContext
		if (!hostId) return c.json({ error: 'hostId required in daemon token' }, StatusCodes.BAD_REQUEST)

		c.var.electricOriginUrl.searchParams.set('table', getTableName(agentCommandDiscoveryRequests))
		const { fragment, params } = buildWhereFragment(agentCommandDiscoveryRequests, [
			{ column: agentCommandDiscoveryRequests.organization_id, value: organizationId },
			{ column: agentCommandDiscoveryRequests.host_id, value: hostId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/daemon/workspace-setup', async (c) => {
		const { organizationId, hostId } = c.var.authContext
		if (!hostId) return c.json({ error: 'hostId required in daemon token' }, StatusCodes.BAD_REQUEST)

		c.var.electricOriginUrl.searchParams.set('table', getTableName(taskWorkspaceSetupForHost))
		const { fragment, params } = buildWhereFragment(taskWorkspaceSetupForHost, [
			{ column: taskWorkspaceSetupForHost.organization_id, value: organizationId },
			{ column: taskWorkspaceSetupForHost.host_id, value: hostId },
		])
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	app.all('/tasks/:taskId/artifacts', async (c) => {
		const taskId = c.req.param('taskId')
		if (!taskId) throw new Error('taskId path param missing')
		if (!isUuid(taskId)) {
			return c.json({ error: 'Invalid taskId format' }, StatusCodes.BAD_REQUEST)
		}

		c.var.electricOriginUrl.searchParams.set('table', getTableName(artifacts))
		const { fragment, params } = buildWhereFragmentForOrgScopedTaskArtifacts(c.var.authContext, taskId)
		applyWhereToUrl(c.var.electricOriginUrl, fragment, params)
		return proxyElectricResponseWithRuntime(config, c.var.electricOriginUrl, undefined, c.req)
	})

	return app
}
