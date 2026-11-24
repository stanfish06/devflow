import { describe, expect, it } from 'vitest'

import { matchActions } from '@/minimalist/lib/palette'

const ITEMS = [
	{ id: 'new', label: 'New task' },
	{ id: 'compact', label: 'Compact this session' },
	{ id: 'dark', label: 'Use dark appearance' },
	{ id: 'fork', label: 'Fork from your last message' },
]

const ids = (items: { id: string }[]) => items.map((item) => item.id)

describe('matchActions', () => {
	it('shows the idle set before you type, adding compact once the context is filling up', () => {
		expect(ids(matchActions(ITEMS, '', null))).toEqual(['new', 'fork'])
		expect(ids(matchActions(ITEMS, '  ', 30))).toEqual(['new', 'fork'])
		expect(ids(matchActions(ITEMS, '', 72))).toEqual(['new', 'compact', 'fork'])
	})

	it('offers the top-level pages before you type, usage next to pull requests', () => {
		const pages = [
			{ id: 'prs', label: 'Go to pull requests' },
			{ id: 'artifacts', label: 'Go to artifacts' },
			{ id: 'usage', label: 'Go to usage' },
		]
		expect(ids(matchActions(pages, '', null))).toEqual(['prs', 'usage'])
		expect(ids(matchActions(pages, 'usage', null))).toEqual(['usage'])
	})

	it('matches any action by label once you type', () => {
		expect(ids(matchActions(ITEMS, 'DARK', null))).toEqual(['dark'])
		expect(ids(matchActions(ITEMS, 'task', null))).toEqual(['new'])
	})
})
