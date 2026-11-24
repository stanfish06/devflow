import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseThemePreference, ThemeProvider } from './theme-provider'

describe('ThemeProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.classList.remove('dark')
  })

  it('applies the stored theme and reports it to onThemeChange', () => {
    vi.useFakeTimers()
    localStorage.setItem('test-theme', JSON.stringify('dark'))
    const onThemeChange = vi.fn()
    render(
      <ThemeProvider storageKey="test-theme" onThemeChange={onThemeChange}>
        <div />
      </ThemeProvider>,
    )
    vi.runAllTimers()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(onThemeChange).toHaveBeenCalledWith('dark')
  })

  // Another owner of the window theme takes over by removing the callback; a report still
  // pending from before must not land after it and overwrite what it set.
  it('drops a pending report once the callback is removed', () => {
    vi.useFakeTimers()
    const onThemeChange = vi.fn()
    const { rerender } = render(
      <ThemeProvider storageKey="test-theme" onThemeChange={onThemeChange}>
        <div />
      </ThemeProvider>,
    )
    rerender(
      <ThemeProvider storageKey="test-theme">
        <div />
      </ThemeProvider>,
    )
    vi.runAllTimers()
    expect(onThemeChange).not.toHaveBeenCalled()
  })

  it('reads stored palette names from older builds as system', () => {
    expect(parseThemePreference('rose-pine')).toBe('system')
    expect(parseThemePreference('light')).toBe('light')
  })
})
