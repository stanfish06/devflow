import { spawn } from 'node:child_process'

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import * as BunServices from '@effect/platform-bun/BunServices'
import { describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option, Ref } from 'effect'
import * as ConfigProvider from 'effect/ConfigProvider'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'

import { makeHostModelCatalogSourceLive } from '../../src/effects/services/host-model-catalog/host-model-catalog.layer'
import { HostModelCatalogSource } from '../../src/effects/services/host-model-catalog/host-model-catalog.service'
import {
	type ClaudeQueryFactory,
	probeClaudeModels,
} from '../../src/effects/services/host-model-catalog/probe-claude-models'
import { probeCodexModels } from '../../src/effects/services/host-model-catalog/probe-codex-models'

const opusInfo: ModelInfo = {
	value: 'opus',
	resolvedModel: 'claude-opus-5',
	displayName: 'Opus',
	description: 'Opus 5',
	supportsEffort: true,
	supportedEffortLevels: ['low', 'medium', 'high'],
	supportsFastMode: true,
	supportsAutoMode: true,
}

/** A query factory whose only real behaviour is `supportedModels` and `close`; anything else dies loudly. */
function fakeQueryFactory(input: {
	readonly supportedModels: () => Promise<ModelInfo[]>
	readonly onClose?: () => void
}): ClaudeQueryFactory {
	const fake = {
		supportedModels: input.supportedModels,
		close: () => input.onClose?.(),
	}
	const query = new Proxy(fake, {
		get(target, property) {
			if (property in target) return target[property as keyof typeof target]
			throw new Error(`unexpected Query.${String(property)} during the model probe`)
		},
	})
	return (() => query) as unknown as ClaudeQueryFactory
}

const configLayer = (values: Record<string, string>) =>
	Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))

describe('probeClaudeModels', () => {
	it.effect('returns the catalog rows and closes the query', () =>
		Effect.gen(function* () {
			const closed = yield* Ref.make(0)
			const query = fakeQueryFactory({
				supportedModels: () => Promise.resolve([opusInfo]),
				onClose: () => Effect.runSync(Ref.update(closed, (n) => n + 1)),
			})
			const entries = yield* probeClaudeModels({ query, claudePath: '/usr/bin/claude', cwd: '/tmp' })
			expect(entries).toMatchObject([{ value: 'opus', label: 'Opus 5', supportsAutoMode: true }])
			expect(yield* Ref.get(closed)).toBe(1)
		}),
	)

	it.effect('fails with a spawn error when the binary cannot be started', () =>
		Effect.gen(function* () {
			const query = (() => {
				throw new Error('ENOENT')
			}) as unknown as ClaudeQueryFactory
			const result = yield* probeClaudeModels({ query, claudePath: '/missing', cwd: '/tmp' }).pipe(Effect.flip)
			expect(result).toMatchObject({ _tag: 'ClaudeModelProbeError', operation: 'spawn' })
		}),
	)

	it.effect('fails with a timeout when the CLI never answers, and still closes it', () =>
		Effect.gen(function* () {
			const closed = yield* Deferred.make<void>()
			const query = fakeQueryFactory({
				supportedModels: () => new Promise<ModelInfo[]>(() => {}),
				onClose: () => Effect.runSync(Deferred.succeed(closed, undefined)),
			})
			const fiber = yield* probeClaudeModels({ query, claudePath: '/usr/bin/claude', cwd: '/tmp' }).pipe(
				Effect.flip,
				Effect.forkChild,
			)
			yield* TestClock.adjust('10 seconds')
			const result = yield* Fiber.join(fiber)
			expect(result).toMatchObject({ _tag: 'ClaudeModelProbeError', operation: 'timeout' })
			yield* Deferred.await(closed)
		}),
	)
})

/**
 * A stand-in for `codex app-server`: answers each request from FAKE_CODEX_RESPONSES (method ->
 * result, or `{ error }`), over the same newline-delimited JSON as the real CLI.
 */
const FAKE_APP_SERVER = `
const responses = JSON.parse(process.env.FAKE_CODEX_RESPONSES)
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
	const message = JSON.parse(line)
	if (message.id === undefined) return
	const response = responses[message.method] ?? {}
	const reply = response.error ? { id: message.id, error: response.error } : { id: message.id, result: response }
	process.stdout.write(JSON.stringify(reply) + '\\n')
})
`

const fakeCodex = (responses: Record<string, unknown>) => () =>
	spawn(process.execPath, ['-e', FAKE_APP_SERVER], {
		env: { ...process.env, FAKE_CODEX_RESPONSES: JSON.stringify(responses) },
		stdio: ['pipe', 'pipe', 'pipe'],
	})

const missingCodex = () => spawn(`/nonexistent-bin/codex-${crypto.randomUUID()}`, ['app-server'])

const signedIn = { 'account/read': { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } }

describe('probeCodexModels', () => {
	it.effect('maps model/list rows into catalog entries', () =>
		probeCodexModels(
			fakeCodex({
				...signedIn,
				'model/list': {
					data: [
						{
							id: 'gpt-6.2-sol',
							displayName: 'GPT-6.2-Sol',
							description: 'Fast, go-to model',
							hidden: false,
							isDefault: false,
							supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
							defaultReasoningEffort: 'low',
							serviceTiers: [{ id: 'priority', name: 'Fast' }],
						},
						{
							id: 'gpt-6-astra',
							displayName: 'GPT-6-Astra',
							isDefault: true,
							supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
							defaultReasoningEffort: 'xhigh',
							serviceTiers: [],
						},
					],
					nextCursor: null,
				},
			}),
		).pipe(
			Effect.map((entries) => {
				expect(entries.map((entry) => entry.value)).toEqual(['gpt-6.2-sol', 'gpt-6-astra'])
				expect(entries[0]).toMatchObject({
					provider: 'codex',
					label: 'GPT-6.2-Sol',
					isDefault: false,
					hidden: false,
					effortLevels: ['low', 'high'],
					defaultEffort: 'low',
					supportsFastMode: true,
					supportsAutoMode: false,
				})
				expect(entries[1]).toMatchObject({ isDefault: true, supportsFastMode: false, defaultEffort: undefined })
			}),
		),
	)

	it.effect('reports not logged in when the CLI has no account', () =>
		probeCodexModels(
			fakeCodex({
				'account/read': { account: null, requiresOpenaiAuth: true },
				'model/list': { data: [{ id: 'gpt-6-sol' }] },
			}),
		).pipe(
			Effect.flip,
			Effect.map((error) =>
				expect(error).toMatchObject({ _tag: 'CodexModelProbeError', reason: 'not_logged_in' }),
			),
		),
	)

	it.effect('reports a malformed model list', () =>
		probeCodexModels(fakeCodex({ ...signedIn, 'model/list': { data: [{ displayName: 'no id' }] } })).pipe(
			Effect.flip,
			Effect.map((error) => expect(error).toMatchObject({ reason: 'malformed_response' })),
		),
	)

	it.effect('reports an app-server error response as a transport failure', () =>
		probeCodexModels(fakeCodex({ ...signedIn, 'model/list': { error: { code: -32000, message: 'boom' } } })).pipe(
			Effect.flip,
			Effect.map((error) => expect(error).toMatchObject({ reason: 'transport' })),
		),
	)

	it.effect('reports a missing codex binary', () =>
		probeCodexModels(missingCodex).pipe(
			Effect.flip,
			Effect.map((error) => expect(error).toMatchObject({ reason: 'binary_missing' })),
		),
	)
})

describe('HostModelCatalogSource', () => {
	it.effect('publishes a snapshot after the first probe with per-provider outcomes', () =>
		Effect.gen(function* () {
			const source = yield* HostModelCatalogSource
			expect(Option.isNone(yield* source.snapshot)).toBe(true)
			const loop = yield* source.run.pipe(Effect.forkChild)
			yield* source.awaitFirstProbe
			const snapshot = yield* source.snapshot
			yield* Fiber.interrupt(loop)
			expect(Option.isSome(snapshot)).toBe(true)
			const catalog = Option.getOrThrow(snapshot)
			expect(catalog.anthropic).toMatchObject({ status: 'unavailable', reason: 'binary_missing' })
			expect(catalog.codex).toMatchObject({ status: 'unavailable', reason: 'binary_missing' })
		}).pipe(
			Effect.provide(
				makeHostModelCatalogSourceLive(
					fakeQueryFactory({ supportedModels: () => Promise.resolve([opusInfo]) }),
					missingCodex,
				).pipe(
					Layer.provide(configLayer({ HOME: '/tmp', PATH: '/nonexistent-bin' })),
					Layer.provide(BunServices.layer),
				),
			),
		),
	)
})
