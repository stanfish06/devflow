import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'

import type { HostModelCatalogEntry } from '@devflow/schemas/zod/model-catalog'
import { Duration, Effect, Option, Schema } from 'effect'

import { AppServerClient, startAppServer } from '@/devflow/codex-app-server'

import { CodexModelProbeError } from './host-model-catalog.errors'

const PROBE_TIMEOUT = Duration.seconds(10)
/** `model/list` pages; the CLI returns every model in one page today. */
const MAX_PAGES = 10

/** The subset of a `model/list` row the catalog reads; unknown fields pass through. */
export const CodexAppServerModel = Schema.Struct({
	id: Schema.String,
	displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	hidden: Schema.optionalKey(Schema.Boolean),
	isDefault: Schema.optionalKey(Schema.Boolean),
	supportedReasoningEfforts: Schema.optionalKey(Schema.Array(Schema.Struct({ reasoningEffort: Schema.String }))),
	defaultReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
	serviceTiers: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
})
export type CodexAppServerModel = typeof CodexAppServerModel.Type

const ModelListResult = Schema.Struct({
	data: Schema.Array(CodexAppServerModel),
	nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** `account/read`: `account` is null when the CLI has no login. */
const AccountReadResult = Schema.Struct({
	account: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	requiresOpenaiAuth: Schema.optionalKey(Schema.Boolean),
})

export function codexAppServerModelToCatalogEntry(
	model: CodexAppServerModel,
	isDefault: boolean,
): HostModelCatalogEntry {
	const effortLevels = (model.supportedReasoningEfforts ?? [])
		.map((effort) => effort.reasoningEffort.trim())
		.filter((level) => level.length > 0)
	const defaultEffort = model.defaultReasoningEffort?.trim() || undefined
	return {
		provider: 'codex',
		value: model.id,
		label: model.displayName?.trim() || model.id,
		description: model.description ?? undefined,
		isDefault,
		hidden: model.hidden ?? false,
		effortLevels,
		defaultEffort: defaultEffort !== undefined && effortLevels.includes(defaultEffort) ? defaultEffort : undefined,
		supportsFastMode: (model.serviceTiers ?? []).some((tier) => tier.id === 'priority'),
		supportsAutoMode: false,
	}
}

/** Keeps the CLI's order; the default is the row the CLI marks, else the first visible one. */
export function codexAppServerModelsToCatalog(models: ReadonlyArray<CodexAppServerModel>): HostModelCatalogEntry[] {
	const defaultId = (models.find((model) => model.isDefault) ?? models.find((model) => !model.hidden) ?? models[0])
		?.id
	return models.map((model) => codexAppServerModelToCatalogEntry(model, model.id === defaultId))
}

/** Starts `codex app-server`; tests pass a fake. */
export type CodexAppServerStarter = () => ChildProcess

const isMissingBinary = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'

const request = (client: AppServerClient, method: string, params: Record<string, unknown>) =>
	Effect.tryPromise({
		try: () => client.request(method, params),
		catch: (cause) =>
			new CodexModelProbeError({ reason: isMissingBinary(cause) ? 'binary_missing' : 'transport', cause }),
	})

const malformed = (cause: unknown) => new CodexModelProbeError({ reason: 'malformed_response', cause })

const listModels = (client: AppServerClient) =>
	Effect.gen(function* () {
		yield* request(client, 'initialize', { clientInfo: { name: 'devflow', title: 'devflow', version: '1' } })
		client.notify('initialized')
		const account = yield* request(client, 'account/read', { refreshToken: false }).pipe(
			Effect.flatMap((value) =>
				Schema.decodeUnknownEffect(AccountReadResult)(value).pipe(Effect.mapError(malformed)),
			),
		)
		if (account.account == null && account.requiresOpenaiAuth !== false) {
			return yield* new CodexModelProbeError({ reason: 'not_logged_in' })
		}
		const models: CodexAppServerModel[] = []
		let cursor: string | null = null
		for (let page = 0; page < MAX_PAGES; page++) {
			const result: typeof ModelListResult.Type = yield* request(
				client,
				'model/list',
				cursor === null ? {} : { cursor },
			).pipe(
				Effect.flatMap((value) =>
					Schema.decodeUnknownEffect(ModelListResult)(value).pipe(Effect.mapError(malformed)),
				),
			)
			models.push(...result.data)
			cursor = result.nextCursor ?? null
			if (cursor === null) break
		}
		return codexAppServerModelsToCatalog(models)
	})

/**
 * Asks the installed Codex CLI which models its login can use: starts `codex app-server`, sends
 * `initialize`, `initialized`, `account/read` and `model/list`, then stops the process.
 */
export const probeCodexModels = Effect.fn('host_model_catalog.probe_codex')(function* (
	start: CodexAppServerStarter = () => startAppServer(homedir()),
) {
	return yield* Effect.acquireUseRelease(
		Effect.sync(() => new AppServerClient(start())),
		listModels,
		(client) => Effect.sync(() => client.close()),
	).pipe(
		Effect.timeoutOption(PROBE_TIMEOUT),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(new CodexModelProbeError({ reason: 'timeout' })),
				onSome: Effect.succeed,
			}),
		),
	)
})
