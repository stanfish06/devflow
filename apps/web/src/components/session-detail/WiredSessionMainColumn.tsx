import type { ReactNode } from 'react'

/** The session page's main column: the conversation and composer. */
export function WiredSessionMainColumn({ children }: { children: ReactNode }) {
	return <div className="relative flex h-full min-h-0 flex-col overflow-hidden [contain:layout] pb-4">{children}</div>
}
