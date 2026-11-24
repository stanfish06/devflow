import type { Theme } from '../components/theme-provider'

/**
 * Diffs and code fences use GitHub's Primer Shiki themes. The `-default` variants match
 * github.com: near-black #0d1117 in dark, white in light.
 */
export const DIFF_SHIKI_DARK = 'github-dark-default'
export const DIFF_SHIKI_LIGHT = 'github-light-default'

export const themeToShiki: Record<Theme, string> = {
	light: DIFF_SHIKI_LIGHT,
	dark: DIFF_SHIKI_DARK,
}

export type ShikiThemeInput = string

/** Markdown code blocks use the same themes as the diff viewer. */
export function themeToShikiInput(theme: Theme | undefined): ShikiThemeInput {
	return theme ? themeToShiki[theme] : DIFF_SHIKI_DARK
}

export function themeToCodeFenceShiki(theme: Theme | undefined): string {
	return themeToShikiInput(theme)
}
