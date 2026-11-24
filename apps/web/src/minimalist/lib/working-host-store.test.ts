import { beforeEach, describe, expect, it } from 'vitest'

import {
	createWorkingHostStore,
	parseWorkingHostChoice,
	resetWorkingHostStoresForTests,
	workingHostStore,
} from './working-host-store'

beforeEach(() => {
	localStorage.clear()
	resetWorkingHostStoresForTests()
})

describe('the working host store', () => {
	it('starts unchosen on a new device', () => {
		expect(createWorkingHostStore('org', 'me').getState().choice).toBeNull()
	})

	it('remembers the choice across reloads, per organization and user', () => {
		createWorkingHostStore('org', 'me').getState().set('mac-studio')
		expect(localStorage.getItem('working-host:v1:org:me')).toContain('mac-studio')
		expect(createWorkingHostStore('org', 'me').getState().choice).toBe('mac-studio')
		expect(createWorkingHostStore('org', 'someone').getState().choice).toBeNull()
		expect(createWorkingHostStore('other-org', 'me').getState().choice).toBeNull()
	})

	it('remembers "All hosts" as a choice of its own', () => {
		createWorkingHostStore('org', 'me').getState().set('all')
		expect(createWorkingHostStore('org', 'me').getState().choice).toBe('all')
	})

	it.each([
		['not json', 'not json'],
		['a number', JSON.stringify({ state: { choice: 3 }, version: 0 })],
		['an empty string', JSON.stringify({ state: { choice: '' }, version: 0 })],
		['no state', JSON.stringify({ version: 0 })],
	])('treats %s in storage as never chosen', (_name, stored) => {
		localStorage.setItem('working-host:v1:org:me', stored)
		expect(createWorkingHostStore('org', 'me').getState().choice).toBeNull()
	})

	it.each([
		['mac-studio', 'mac-studio'],
		['all', 'all'],
		['', null],
		[null, null],
		[undefined, null],
		[42, null],
	])('parses %j as %j', (value, expected) => {
		expect(parseWorkingHostChoice(value)).toBe(expected)
	})

	it('shares one store per organization and user', () => {
		expect(workingHostStore('org', 'me')).toBe(workingHostStore('org', 'me'))
		expect(workingHostStore('org', 'me')).not.toBe(workingHostStore('org', 'someone'))
	})
})
