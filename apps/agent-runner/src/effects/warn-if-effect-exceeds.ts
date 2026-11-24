import { Duration, Effect, Fiber } from 'effect'

interface WarnIfEffectExceedsOptions {
	readonly attributes: Record<string, string | number | null | undefined>
	readonly logMessage: string
	readonly threshold: Duration.Duration
}

export const warnIfEffectExceeds = <A, E, R>(effect: Effect.Effect<A, E, R>, options: WarnIfEffectExceedsOptions) =>
	Effect.gen(function* () {
		const watchdog = yield* Effect.sleep(options.threshold).pipe(
			Effect.timed,
			Effect.flatMap(([elapsed]) =>
				Effect.logWarning(options.logMessage).pipe(
					Effect.annotateLogs({
						...options.attributes,
						processing_duration_ms: Duration.toMillis(elapsed),
						threshold_ms: Duration.toMillis(options.threshold),
					}),
				),
			),
			Effect.forkScoped,
		)
		return yield* effect.pipe(Effect.ensuring(Fiber.interrupt(watchdog)))
	})
