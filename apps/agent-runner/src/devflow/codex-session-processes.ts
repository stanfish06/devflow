import logger from '@/logger'

export class CodexSessionClosedError extends Error {
	override readonly name = 'CodexSessionClosedError'
}

export interface CodexSessionProcess {
	close(): Promise<void>
	whenExited(): Promise<unknown>
}

interface ProcessEntry<T> {
	opening: AbortController
	resource: Promise<T>
	turnEnd?: Promise<void>
	activeTurn?: PromiseWithResolvers<void>
	retiring: boolean
	forced?: Error
	cancelled?: boolean
	closed: PromiseWithResolvers<void>
	closing?: Promise<void>
}

/** A process belongs to one session; at most one turn at a time owns its handlers. */
export class CodexSessionProcesses<T extends CodexSessionProcess> {
	private readonly entries = new Map<string, ProcessEntry<T>>()
	private stopped = false

	async acquire(
		sessionId: string,
		open: (signal: AbortSignal) => Promise<T>,
	): Promise<{ process: T; wasCancelled(): boolean; release(retire?: boolean): Promise<void> }> {
		for (;;) {
			if (this.stopped) throw new CodexSessionClosedError('Codex session processes have shut down')
			const entry = this.entries.get(sessionId) ?? this.start(sessionId, open)
			if (entry.retiring) {
				if (entry.forced) throw entry.forced
				await entry.closed.promise
				if (entry.forced) throw entry.forced
				continue
			}
			const previous = entry.turnEnd
			const turnEnd = Promise.withResolvers<void>()
			entry.turnEnd = turnEnd.promise
			if (previous) await previous
			if (entry.retiring) {
				turnEnd.resolve()
				if (entry.forced) throw entry.forced
				await entry.closed.promise
				if (entry.forced) throw entry.forced
				continue
			}
			entry.activeTurn = turnEnd
			let process: T
			try {
				process = await entry.resource
				if (entry.forced) throw entry.forced
			} catch (error) {
				entry.activeTurn = undefined
				turnEnd.resolve()
				await this.force(sessionId, entry)
				throw entry.forced instanceof CodexSessionClosedError ? entry.forced : error
			}

			let released: Promise<void> | undefined
			return {
				process,
				wasCancelled: () => this.stopped || entry.cancelled === true,
				release: (retire = false) => {
					if (released) return released
					if (entry.turnEnd === turnEnd.promise) entry.turnEnd = undefined
					entry.activeTurn = undefined
					turnEnd.resolve()
					released = retire || entry.retiring ? this.close(sessionId, entry) : Promise.resolve()
					return released
				},
			}
		}
	}

	/** Stop accepting turns on this process; release it once the current turn returns its slot. */
	retire(sessionId: string): Promise<void> {
		const entry = this.entries.get(sessionId)
		if (!entry) return Promise.resolve()
		entry.retiring = true
		return entry.activeTurn ? entry.closed.promise.then(() => entry.closing) : this.close(sessionId, entry)
	}

	/** Close even if an active turn is waiting on an app-server response. Pending acquisitions fail. */
	forceClose(sessionId: string): Promise<void> {
		const entry = this.entries.get(sessionId)
		if (!entry) return Promise.resolve()
		entry.cancelled = true
		return this.force(sessionId, entry)
	}

	async shutdown(): Promise<void> {
		this.stopped = true
		const results = await Promise.allSettled([...this.entries].map(([id, entry]) => this.force(id, entry)))
		const failures = results.filter((result) => result.status === 'rejected')
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				'Failed to close Codex session processes',
			)
	}

	private start(id: string, open: (signal: AbortSignal) => Promise<T>): ProcessEntry<T> {
		const opening = new AbortController()
		const entry: ProcessEntry<T> = {
			opening,
			resource: Promise.resolve()
				.then(() => {
					opening.signal.throwIfAborted()
					return open(opening.signal)
				})
				.then((process) => {
					void process.whenExited().then(onExit, onExit)
					return process
				}),
			retiring: false,
			closed: Promise.withResolvers<void>(),
		}
		this.entries.set(id, entry)
		const onExit = () => {
			// A late notification from an old process must never evict its replacement.
			if (this.entries.get(id) !== entry || entry.closing) return
			void this.force(id, entry).catch((error: unknown) => {
				logger.error({ error, sessionId: id }, 'Failed to release an exited Codex process')
			})
		}
		return entry
	}

	private force(id: string, entry: ProcessEntry<T>): Promise<void> {
		const message = `Codex process for session ${id} was closed`
		entry.forced ??= entry.cancelled || this.stopped ? new CodexSessionClosedError(message) : new Error(message)
		entry.opening.abort(entry.forced)
		entry.activeTurn?.resolve()
		return this.close(id, entry)
	}

	private close(id: string, entry: ProcessEntry<T>): Promise<void> {
		entry.retiring = true
		entry.closing ??= entry.resource
			.then(
				(process) => process.close(),
				() => undefined, // The factory owns partial setup on open failure.
			)
			.finally(() => {
				if (this.entries.get(id) === entry) this.entries.delete(id)
				entry.closed.resolve()
			})
		return entry.closing
	}
}
