import { describe, expect, it } from 'vitest'

import { matchShortcut, shortcutHint } from '@/minimalist/lib/shortcuts'

const press = (key: string, code: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) =>
	matchShortcut({
		key,
		code,
		metaKey: !mods.ctrl,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt,
	})

describe('matchShortcut', () => {
	it('tells shortcuts on the same key apart by their modifiers', () => {
		expect(press('b', 'KeyB')?.id).toBe('sidebar')
		expect(press('∫', 'KeyB', { alt: true })?.id).toBe('panel')
		expect(press('[', 'BracketLeft')?.id).toBe('back')
		expect(press('“', 'BracketLeft', { alt: true })?.id).toBe('previous-task')
		expect(press('‘', 'BracketRight', { alt: true })?.id).toBe('next-task')
		expect(press(']', 'BracketRight')?.id).toBe('forward')
		expect(press('A', 'KeyA', { shift: true })?.id).toBe('archive')
		expect(press('å', 'KeyA', { alt: true })?.id).toBe('next-attention')
		expect(press('k', 'KeyK', { ctrl: true })?.id).toBe('search')
	})

	it('matches recent-task digits only within their range', () => {
		expect(press('£', 'Digit3', { alt: true })).toEqual({ id: 'recent', digit: 3 })
		expect(press('ª', 'Digit9', { alt: true })).toBeNull()
		expect(press('3', 'Digit3')).toBeNull()
		expect(press('3', 'Numpad3')).toBeNull()
		expect(press('#', 'Digit3', { shift: true })).toBeNull()
	})

	it('ignores keys without ⌘ or Ctrl, and unbound keys', () => {
		expect(
			matchShortcut({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }),
		).toBeNull()
		expect(press('n', 'KeyN', { shift: true })).toBeNull()
		expect(press('q', 'KeyQ')).toBeNull()
	})
})

describe('shortcutHint', () => {
	it('drops the spaces', () => {
		expect(shortcutHint('archive')).toBe('⇧⌘A')
		expect(shortcutHint('settings')).toBe('⌘,')
	})

	it('lists the task-navigation bindings', () => {
		expect(shortcutHint('previous-task')).toBe('⌥⌘[')
		expect(shortcutHint('next-task')).toBe('⌥⌘]')
	})
})
