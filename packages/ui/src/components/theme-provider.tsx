import * as React from 'react'
import { useLocalStorage } from '../hooks/use-local-storage'

/** The applied theme: `data-theme` on <html>, plus the `dark` class in dark. The user's pick is
 * `data-theme-preference`, read by the desktop client to match its window to the page. */
export type Theme = 'light' | 'dark'
/** What the user picked; `system` follows the OS color scheme. */
export type ThemePreference = 'system' | Theme

interface ThemeContextType {
  /** The applied theme. */
  theme: Theme
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = React.createContext<ThemeContextType | undefined>(undefined)

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeSystemScheme(onChange: () => void) {
  const media = matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** Stored values from older builds (named palettes) count as `system`. */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

interface ThemeProviderProps {
  children: React.ReactNode
  storageKey?: string
  onThemeChange?: (theme: Theme) => void
}

export function ThemeProvider({ children, storageKey = 'ui-theme', onThemeChange }: ThemeProviderProps) {
  const [stored, setStored, isLoaded] = useLocalStorage<unknown>(storageKey, 'system')
  const preference = parseThemePreference(stored)
  const systemDark = React.useSyncExternalStore(
    subscribeSystemScheme,
    () => matchMedia(DARK_QUERY).matches,
    () => false,
  )
  const theme: Theme = preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light'

  React.useEffect(() => {
    if (!isLoaded) return
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-theme-preference', preference)
    root.classList.toggle('dark', theme === 'dark')

    if (!onThemeChange) return
    const timeout = setTimeout(() => {
      onThemeChange(theme)
    }, 10)
    // A report still pending when the theme or callback changes is stale; dropping it keeps
    // it from overwriting whatever owns the window theme now.
    return () => clearTimeout(timeout)
  }, [theme, preference, onThemeChange, isLoaded])

  const value = React.useMemo(
    () => ({ theme, preference, setPreference: (next: ThemePreference) => setStored(next) }),
    [theme, preference, setStored],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = React.useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

/** Like useTheme, but returns undefined outside a ThemeProvider (tests, isolated
 * renders) so consumers can fall back to a default theme instead of throwing. */
export function useOptionalTheme() {
  return React.useContext(ThemeContext)
}
