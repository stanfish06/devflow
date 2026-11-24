import { useOptionalTheme } from '@devflow/ui/components/theme-provider'

/** Whether the app renders dark: the shared theme setting, resolved against the OS scheme. Light outside a ThemeProvider. */
export function useMinimalistDark(): boolean {
	return useOptionalTheme()?.theme === 'dark'
}
