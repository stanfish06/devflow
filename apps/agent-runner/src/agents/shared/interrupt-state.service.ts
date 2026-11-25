import type { SessionErrorReason } from '@devflow/schemas/effect/session/session-error-reason'
import { Context, Effect, Layer, Ref } from 'effect'

export interface InterruptStateSnapshot {
	wasInterrupted: boolean
	resumeWithPrompt: string | null
}

/**
 * Why the daemon itself stopped a run, to record on the session instead of "interrupted": the
 * session fails with this reason and message once the agent has stopped.
 */
export interface RunStopFailure {
	readonly reason: SessionErrorReason
	readonly message: string
}

export interface InterruptStateService {
	get: Effect.Effect<InterruptStateSnapshot>
	wasInterrupted: Effect.Effect<boolean>
	resumeWithPrompt: Effect.Effect<string | null>
	markInterrupted: (resumeWithPrompt: string | null) => Effect.Effect<void>
	/** The failure the daemon stopped the run for, if it did. */
	failure: Effect.Effect<RunStopFailure | null>
	/**
	 * Stop the run as failed: marks it interrupted (with nothing to resume) and records why. Returns
	 * false, changing nothing, when an earlier failure was already recorded, so only the first stops
	 * the run.
	 */
	markFailed: (failure: RunStopFailure) => Effect.Effect<boolean>
}

export class InterruptState extends Context.Service<InterruptState, InterruptStateService>()('InterruptState') {}

export const makeInterruptState = Effect.gen(function* () {
	const ref = yield* Ref.make<InterruptStateSnapshot>({ wasInterrupted: false, resumeWithPrompt: null })
	const failure = yield* Ref.make<RunStopFailure | null>(null)

	return {
		get: Ref.get(ref),
		wasInterrupted: Ref.get(ref).pipe(Effect.map((state) => state.wasInterrupted)),
		resumeWithPrompt: Ref.get(ref).pipe(Effect.map((state) => state.resumeWithPrompt)),
		markInterrupted: (resumeWithPrompt) => Ref.set(ref, { wasInterrupted: true, resumeWithPrompt }),
		failure: Ref.get(failure),
		markFailed: (next) =>
			Ref.modify(failure, (current) => (current === null ? [true, next] : [false, current])).pipe(
				Effect.tap((recorded) =>
					recorded ? Ref.set(ref, { wasInterrupted: true, resumeWithPrompt: null }) : Effect.void,
				),
			),
	} satisfies InterruptStateService
})

export const InterruptStateLive = Layer.effect(InterruptState, makeInterruptState)

export const createInterruptState = () => Effect.runPromise(InterruptState.pipe(Effect.provide(InterruptStateLive)))
