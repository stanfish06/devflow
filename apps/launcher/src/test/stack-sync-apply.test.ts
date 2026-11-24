import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import {
	SyncApplyEnvironment,
	SyncApplyEnvironmentError,
	type SyncApplyEnvironmentShape,
} from '../environment/sync-apply-environment'
import { emptyRegistry, type StackRecord } from '../lib/registry'
import { applyStackSync } from '../sync/stack-sync-apply'
import type { StackPlan } from '../sync/stack-sync.types'

const stack = {
	id: 'apply-test',
	routes: { api: 'https://api.apply-test.localhost' },
} as unknown as StackRecord

const plan: StackPlan = {
	stackId: stack.id,
	repoRoot: '/tmp/apply-test',
	registryPath: '/tmp/apply-test-registry.json',
	desired: stack,
	actions: [
		{ type: 'persist-registry', change: { kind: 'create', oldValue: null, newValue: stack } },
		{ type: 'install-workspace-projection', change: { kind: 'create', oldValue: null, newValue: stack } },
		{ type: 'install-caddy-routes', change: { kind: 'create', oldValue: null, newValue: stack.routes } },
	],
}

describe.skipIf(Boolean(process.env.CI))('applyStackSync', () => {
	it.effect('applies Compose start before Postgres setup and records both actions', () => {
		const calls: string[] = []
		const environment: SyncApplyEnvironmentShape = {
			persistRegistry: () => Effect.succeed(emptyRegistry()),
			installWorkspaceProjection: () => Effect.void,
			installCaddyRoutes: () => Effect.void,
			cleanupLegacyRedis: () => Effect.sync(() => void calls.push('cleanup')),
			startCompose: () => Effect.sync(() => void calls.push('compose')),
			setupPostgres: () => Effect.sync(() => void calls.push('postgres')),
			seedOrganization: () => Effect.sync(() => void calls.push('seed')),
		}
		const composePlan: StackPlan = {
			...plan,
			actions: [
				{ type: 'cleanup-legacy-redis', stack },
				{ type: 'start-compose', stack },
				{ type: 'setup-postgres', stack },
			],
		}

		return Effect.gen(function* () {
			const result = yield* applyStackSync(composePlan)
			expect(calls).toEqual(['cleanup', 'compose', 'postgres'])
			expect(result.appliedActions).toBe(3)
		}).pipe(Effect.provideService(SyncApplyEnvironment, environment))
	})

	it.effect('interprets actions in order and hands the persisted registry to Caddy routes', () => {
		const calls: string[] = []
		const environment: SyncApplyEnvironmentShape = {
			persistRegistry: ({ stack: persisted }) =>
				Effect.sync(() => {
					calls.push(`registry:${persisted.id}`)
					return { ...emptyRegistry(), stacks: { [persisted.id]: persisted } }
				}),
			installWorkspaceProjection: ({ stack: projected }) =>
				Effect.sync(() => void calls.push(`workspace:${projected.id}`)),
			installCaddyRoutes: ({ registry }) =>
				Effect.sync(() => void calls.push(`caddy:${Object.keys(registry.stacks).join(',')}`)),
			cleanupLegacyRedis: () => Effect.sync(() => void calls.push('cleanup')),
			startCompose: () => Effect.sync(() => void calls.push('compose')),
			setupPostgres: () => Effect.sync(() => void calls.push('postgres')),
			seedOrganization: () => Effect.sync(() => void calls.push('seed')),
		}

		return applyStackSync(plan).pipe(
			Effect.provideService(SyncApplyEnvironment, environment),
			Effect.tap((result) =>
				Effect.sync(() => {
					expect(result.stack).toBe(stack)
					expect(result.appliedActions).toBe(3)
					expect(calls).toEqual(['registry:apply-test', 'workspace:apply-test', 'caddy:apply-test'])
				}),
			),
		)
	})

	it.effect('stops at the first actuator failure', () => {
		const calls: string[] = []
		const environment: SyncApplyEnvironmentShape = {
			persistRegistry: () =>
				Effect.fail(new SyncApplyEnvironmentError({ operation: 'persist_registry', reason: 'disk full' })),
			installWorkspaceProjection: () => Effect.sync(() => void calls.push('workspace')),
			installCaddyRoutes: () => Effect.sync(() => void calls.push('caddy')),
			cleanupLegacyRedis: () => Effect.sync(() => void calls.push('cleanup')),
			startCompose: () => Effect.sync(() => void calls.push('compose')),
			setupPostgres: () => Effect.sync(() => void calls.push('postgres')),
			seedOrganization: () => Effect.sync(() => void calls.push('seed')),
		}

		return Effect.gen(function* () {
			const error = yield* applyStackSync(plan).pipe(Effect.flip)
			expect(error.action).toBe('persist-registry')
			expect(error.actionIndex).toBe(0)
			expect(error.reason).toBe('disk full')
			expect(calls).toEqual([])
		}).pipe(Effect.provideService(SyncApplyEnvironment, environment))
	})

	it.effect('seeds after Compose setup and remains idempotent on repeat execution', () => {
		const calls: string[] = []
		const organizations = new Map<string, { workosOrganizationId: string; name: string }>()
		const organization = { id: 'organization-id', workosOrganizationId: 'workos-id', name: 'Local Org' }
		const environment: SyncApplyEnvironmentShape = {
			persistRegistry: () => Effect.succeed(emptyRegistry()),
			installWorkspaceProjection: () => Effect.void,
			installCaddyRoutes: () => Effect.void,
			cleanupLegacyRedis: () => Effect.sync(() => void calls.push('cleanup')),
			startCompose: () => Effect.sync(() => void calls.push('compose')),
			setupPostgres: () => Effect.sync(() => void calls.push('postgres')),
			seedOrganization: ({ organization: value }) =>
				Effect.sync(() => {
					calls.push('seed')
					organizations.set(value.id, {
						workosOrganizationId: value.workosOrganizationId,
						name: value.name,
					})
				}),
		}
		const seedPlan: StackPlan = {
			...plan,
			actions: [
				{ type: 'cleanup-legacy-redis', stack },
				{ type: 'start-compose', stack },
				{ type: 'setup-postgres', stack },
				{ type: 'seed-organization', organization },
			],
		}

		return Effect.gen(function* () {
			yield* applyStackSync(seedPlan)
			yield* applyStackSync(seedPlan)
			expect(calls).toEqual(['cleanup', 'compose', 'postgres', 'seed', 'cleanup', 'compose', 'postgres', 'seed'])
			expect([...organizations.entries()]).toEqual([
				['organization-id', { workosOrganizationId: 'workos-id', name: 'Local Org' }],
			])
		}).pipe(Effect.provideService(SyncApplyEnvironment, environment))
	})

	it.effect('narrows seed actuator failures and records the failed action', () => {
		const organization = { id: 'organization-id', workosOrganizationId: 'workos-id', name: 'Local Org' }
		const environment: SyncApplyEnvironmentShape = {
			persistRegistry: () => Effect.succeed(emptyRegistry()),
			installWorkspaceProjection: () => Effect.void,
			installCaddyRoutes: () => Effect.void,
			cleanupLegacyRedis: () => Effect.void,
			startCompose: () => Effect.void,
			setupPostgres: () => Effect.void,
			seedOrganization: () =>
				Effect.fail(
					new SyncApplyEnvironmentError({ operation: 'seed_organization', reason: 'database rejected seed' }),
				),
		}
		const seedPlan: StackPlan = {
			...plan,
			actions: [{ type: 'seed-organization', organization }],
		}

		return Effect.gen(function* () {
			const error = yield* applyStackSync(seedPlan).pipe(Effect.flip)
			expect(error.action).toBe('seed-organization')
			expect(error.actionIndex).toBe(0)
			expect(error.reason).toBe('database rejected seed')
		}).pipe(Effect.provideService(SyncApplyEnvironment, environment))
	})
})
