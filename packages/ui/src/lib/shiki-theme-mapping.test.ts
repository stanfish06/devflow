import { describe, expect, it } from 'vitest'

import { themeToShiki, themeToShikiInput } from './shiki-theme-mapping'

describe('shiki theme mapping', () => {
	it('maps light and dark to the GitHub Primer themes', () => {
		expect(themeToShiki.light).toBe('github-light-default')
		expect(themeToShiki.dark).toBe('github-dark-default')
		expect(themeToShikiInput(undefined)).toBe('github-dark-default')
	})
})
