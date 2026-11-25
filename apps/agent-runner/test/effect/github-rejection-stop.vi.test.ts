import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { createInterruptState } from '@/agents/shared/interrupt-state.service'
import type { SessionContext } from '@/agents/shared/run-session'
import { finalizeInterruptedRun } from '@/effects/services/claude-sessions/complete-interrupted-run'
import type { ClaudeSdkSession } from '@/effects/services/claude-sessions/sdk/claude-sdk-session.service'
import { observeDaemonStopRequest } from '@/effects/services/claude-sessions/workflows/live-controls'
import type { GithubRejectionMatch } from '@/effects/services/github-credentials/rejection-signatures'
import { stopRunOnGithubRejection } from '@/effects/services/github-credentials/stop-on-github-rejection'

import { makeBasicEffectSession } from '../fixtures/effect-claude-runtime'
import { makeMockDaemonApiLayer } from '../mocks/daemon-api.mock'
import { makeHostLoginGithubCredentials } from '../mocks/github-credentials.mock'

const SESSION_ID = 'effect-session-1'
const REJECTION: GithubRejectionMatch = {
	signature: 'permission_denied',
	login: 'stan-work',
	excerpt: 'remote: Permission to acme/api.git denied to stan-work.',
}

describe('stopRunOnGithubRejection', () => {
	it('records why the run stops when the API says GitHub refused the account', async () => {
		const interruptState = await createInterruptState()
		const credentials = makeHostLoginGithubCredentials({
			reportRejection: () => Effect.succeed({ reason: 'github_token_rejected', login: 'stan-work' }),
		})

		await expect(
			Effect.runPromise(
				stopRunOnGithubRejection({ sessionId: SESSION_ID, rejection: REJECTION, interruptState }).pipe(
					Effect.provide(credentials),
				),
			),
		).resolves.toBe(true)
		await expect(Effect.runPromise(interruptState.failure)).resolves.toEqual({
			reason: 'github_token_rejected',
			message: 'stan-work',
		})
		await expect(Effect.runPromise(interruptState.get)).resolves.toEqual({
			wasInterrupted: true,
			resumeWithPrompt: null,
		})
	})

	it('leaves the run alone when there is nothing to stop for', async () => {
		const interruptState = await createInterruptState()

		await expect(
			Effect.runPromise(
				stopRunOnGithubRejection({ sessionId: SESSION_ID, rejection: REJECTION, interruptState }).pipe(
					Effect.provide(makeHostLoginGithubCredentials()),
				),
			),
		).resolves.toBe(false)
		await expect(Effect.runPromise(interruptState.failure)).resolves.toBeNull()
		await expect(Effect.runPromise(interruptState.wasInterrupted)).resolves.toBe(false)
	})
})

describe('observeDaemonStopRequest', () => {
	const fakeSdkSession = (interrupt: Effect.Effect<void, Error>) => {
		const calls: string[] = []
		const sdkSession = {
			controls: { interrupt: interrupt.pipe(Effect.tap(() => Effect.sync(() => calls.push('interrupt')))) },
			input: { close: Effect.sync(() => calls.push('close')) },
		} as unknown as ClaudeSdkSession
		return { sdkSession, calls }
	}

	it('waits for the request, then interrupts the agent and ends its process', async () => {
		const { sdkSession, calls } = fakeSdkSession(Effect.void)
		await Effect.runPromise(
			Effect.gen(function* () {
				const stopRequested = yield* Deferred.make<void>()
				const fiber = yield* Effect.forkChild(
					observeDaemonStopRequest({ sessionId: SESSION_ID, stopRequested, sdkSession }),
				)
				yield* Effect.yieldNow
				expect(calls).toEqual([])
				yield* Deferred.succeed(stopRequested, undefined)
				yield* Fiber.join(fiber)
			}),
		)
		expect(calls).toEqual(['interrupt', 'close'])
	})

	it('still ends the process when the interrupt fails', async () => {
		const { sdkSession, calls } = fakeSdkSession(Effect.fail(new Error('already idle')))
		await Effect.runPromise(
			Effect.gen(function* () {
				const stopRequested = yield* Deferred.make<void>()
				yield* Deferred.succeed(stopRequested, undefined)
				yield* observeDaemonStopRequest({ sessionId: SESSION_ID, stopRequested, sdkSession })
			}),
		)
		expect(calls).toEqual(['close'])
	})
})

describe('finalizeInterruptedRun', () => {
	it('fails the session with the recorded reason and the refused login', async () => {
		const updates: unknown[] = []
		const interruptState = await createInterruptState()
		await Effect.runPromise(interruptState.markFailed({ reason: 'github_no_repo_access', message: 'stan-work' }))
		const context = {
			session: makeBasicEffectSession(),
			services: { shutdown: { isDaemonShuttingDown: () => false } } as unknown as SessionContext['services'],
			interruptState,
			continuationKind: 'ordinary',
		} satisfies SessionContext

		await Effect.runPromise(
			finalizeInterruptedRun({ context, setupArtifactPaths: () => Promise.reject(new Error('unused')) }).pipe(
				Effect.provide(
					makeMockDaemonApiLayer({
						updateSession: (input) =>
							Effect.sync(() => {
								updates.push(input)
								return { success: true, transactionId: '1' } as never
							}),
					}),
				),
			),
		)

		expect(updates).toEqual([
			{
				sessionId: SESSION_ID,
				status: 'failed',
				errorReason: 'github_no_repo_access',
				errorMessage: 'stan-work',
			},
		])
	})
})
