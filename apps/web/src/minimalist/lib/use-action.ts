import { useRef, useState } from 'react'

import { useUi } from '@/minimalist/lib/ui-state'

/**
 * Run one async action at a time and report a failure. `toast` shows the failure as a
 * toast; `inline` keeps it in `error` for the caller to show, for dialogs, whose
 * backdrop covers the toast and hides it from screen readers. `failure` is the copy for a
 * failure, or picks it from the error when some failures need their own words.
 */
export function useAction(report: 'toast' | 'inline' = 'toast') {
	const { showToast } = useUi()
	const lock = useRef(false)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const run = async (action: () => Promise<unknown>, failure: string | ((error: unknown) => string)) => {
		if (lock.current) return false
		lock.current = true
		setPending(true)
		setError(null)
		try {
			await action()
			return true
		} catch (cause) {
			const message = typeof failure === 'string' ? failure : failure(cause)
			if (report === 'toast') showToast(message)
			else setError(message)
			return false
		} finally {
			lock.current = false
			setPending(false)
		}
	}
	return { pending, error, run }
}
