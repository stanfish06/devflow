/**
 * Single-user auth: the one local user and its access token come from the API's
 * `POST /devflow/auth/session` (apps/api/src/devflow/local-auth.ts).
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export interface AuthUser {
	object: 'user'
	id: string
	email: string
	emailVerified: boolean
	profilePictureUrl: string | null
	firstName: string | null
	lastName: string | null
	lastSignInAt: string | null
	externalId: string | undefined
	createdAt: string
	updatedAt: string
}

type SignInOptions = { context?: string; organizationId?: string; state?: unknown; loginHint?: string }

export interface AuthContextValue {
	isLoading: boolean
	user: AuthUser | null
	role: string | null
	roles: string[] | null
	organizationId: string | null
	permissions: string[]
	featureFlags: string[]
	getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>
	getUser: () => AuthUser | null
	signIn: (options?: SignInOptions) => Promise<void>
	signUp: (options?: SignInOptions) => Promise<void>
	signOut: (options?: { returnTo?: string; navigate?: boolean }) => void
	switchToOrganization: (options: { organizationId: string }) => Promise<void>
	getSignInUrl: (options?: SignInOptions) => Promise<string>
	getSignUpUrl: (options?: SignInOptions) => Promise<string>
}

type LocalSession = {
	accessToken: string
	expiresAt: number
	organizationId: string
	user: AuthUser
}

// Refresh this long before expiry so requests never carry a token about to lapse.
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const RETRY_DELAY_MS = 1500

async function fetchSession(): Promise<LocalSession> {
	const response = await fetch(`${import.meta.env.VITE_PUBLIC_DEVFLOW_API_ORIGIN}/devflow/auth/session`, {
		method: 'POST',
	})
	if (!response.ok) throw new Error(`Could not get a local session: HTTP ${response.status}`)
	return (await response.json()) as LocalSession
}

const LocalAuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
	const [session, setSession] = useState<LocalSession | null>(null)
	const inflight = useRef<Promise<LocalSession> | null>(null)
	const sessionRef = useRef<LocalSession | null>(null)

	const refresh = useCallback(async (): Promise<LocalSession> => {
		inflight.current ??= fetchSession()
			.then((next) => {
				sessionRef.current = next
				setSession(next)
				return next
			})
			.finally(() => {
				inflight.current = null
			})
		return inflight.current
	}, [])

	// Load on mount; retry while the API is still starting.
	useEffect(() => {
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const attempt = () => {
			refresh().catch(() => {
				if (!cancelled) timer = setTimeout(attempt, RETRY_DELAY_MS)
			})
		}
		attempt()
		return () => {
			cancelled = true
			if (timer) clearTimeout(timer)
		}
	}, [refresh])

	// Renew ahead of expiry.
	useEffect(() => {
		if (!session) return
		const timer = setTimeout(
			() => void refresh().catch(() => undefined),
			Math.max(session.expiresAt - Date.now() - REFRESH_MARGIN_MS, 1000),
		)
		return () => clearTimeout(timer)
	}, [session, refresh])

	const getAccessToken = useCallback(
		async (options?: { forceRefresh?: boolean }) => {
			const current = sessionRef.current
			if (!options?.forceRefresh && current && current.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
				return current.accessToken
			}
			return (await refresh()).accessToken
		},
		[refresh],
	)

	const value = useMemo(
		() =>
			({
				isLoading: session === null,
				user: session?.user ?? null,
				role: session ? 'admin' : null,
				roles: session ? ['admin'] : null,
				organizationId: session?.organizationId ?? null,
				permissions: [],
				featureFlags: [],
				getAccessToken,
				getUser: () => sessionRef.current?.user ?? null,
				// Single local user: there is no sign-in page, other account or other org to switch to.
				signIn: async () => undefined,
				signUp: async () => undefined,
				signOut: () => undefined,
				switchToOrganization: async () => undefined,
				getSignInUrl: async () => '/',
				getSignUpUrl: async () => '/',
			}) satisfies AuthContextValue,
		[session, getAccessToken],
	)

	return <LocalAuthContext.Provider value={value}>{children}</LocalAuthContext.Provider>
}

export function useAuth(): AuthContextValue {
	const value = useContext(LocalAuthContext)
	if (!value) throw new Error('useAuth must be used inside AuthProvider')
	return value
}
