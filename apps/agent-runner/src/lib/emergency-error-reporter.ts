type EmergencyErrorType = 'logger_transport_error' | 'unhandled_rejection'

/** Write a process-level error to stderr without going through the logger. */
export function reportEmergencyError(reason: unknown, errorType: EmergencyErrorType): void {
	try {
		const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
		process.stderr.write(`[${errorType}] ${detail}\n`)
	} catch {
		// stderr may be unavailable when the native parent disconnects.
	}
}
