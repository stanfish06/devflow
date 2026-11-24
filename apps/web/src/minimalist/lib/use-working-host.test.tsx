import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkingHost, workingHostState } from './use-working-host'
import { resetWorkingHostStoresForTests } from './working-host-store'

const { useHosts, useBrowserAuth } = vi.hoisted(() => ({ useHosts: vi.fn(), useBrowserAuth: vi.fn() }))
vi.mock('@/minimalist/lib/data', () => ({ useHosts }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth }))

function hostView(id: string, online = true) {
	return { host: { host_id: id }, name: id, online }
}

const STORAGE_KEY = 'working-host:v1:org:me'

beforeEach(() => {
	localStorage.clear()
	resetWorkingHostStoresForTests()
	useBrowserAuth.mockReturnValue({ user: { id: 'me' }, organizationId: 'org' })
	useHosts.mockReturnValue({ hosts: [], isReady: true })
})

function savedChoice() {
	return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')?.state?.choice
}

describe('the first visit on a device', () => {
	it('picks the first online host and saves it', () => {
		useHosts.mockReturnValue({
			hosts: [hostView('linux-box'), hostView('mac-studio'), hostView('old-laptop', false)],
			isReady: true,
		})
		const { result } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'linux-box', state: 'online', isReady: true })
		expect(result.current.host?.name).toBe('linux-box')
		expect(savedChoice()).toBe('linux-box')
	})

	it('starts on every host when none is online, and stays there once one comes online', () => {
		useHosts.mockReturnValue({ hosts: [hostView('old-laptop', false)], isReady: true })
		const { result, rerender } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'all', state: 'all', host: null })
		expect(savedChoice()).toBe('all')
		useHosts.mockReturnValue({ hosts: [hostView('mac-studio')], isReady: true })
		rerender()
		expect(result.current.id).toBe('all')
	})

	it('waits for the host list before choosing', () => {
		useHosts.mockReturnValue({ hosts: [], isReady: false })
		const { result, rerender } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'all', isReady: false })
		expect(savedChoice()).toBeUndefined()
		useHosts.mockReturnValue({ hosts: [hostView('mac-studio')], isReady: true })
		rerender()
		expect(result.current.id).toBe('mac-studio')
		expect(savedChoice()).toBe('mac-studio')
	})
})

describe('a saved working host', () => {
	beforeEach(() => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { choice: 'mac-studio' }, version: 0 }))
	})

	it('stays chosen, greyed, when it goes offline', () => {
		useHosts.mockReturnValue({ hosts: [hostView('linux-box'), hostView('mac-studio', false)], isReady: true })
		const { result } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'mac-studio', state: 'offline' })
		expect(result.current.host?.name).toBe('mac-studio')
	})

	it('stays chosen as missing when its registration is gone', () => {
		useHosts.mockReturnValue({ hosts: [hostView('linux-box')], isReady: true })
		const { result } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'mac-studio', state: 'missing', host: null })
		expect(savedChoice()).toBe('mac-studio')
	})

	it('is not called missing while the host list is still loading', () => {
		useHosts.mockReturnValue({ hosts: [], isReady: false })
		const { result } = renderHook(() => useWorkingHost())
		expect(result.current).toMatchObject({ id: 'mac-studio', isReady: false })
		expect(result.current.state).not.toBe('missing')
	})

	it('changes only when you pick, and every reader sees the pick', () => {
		useHosts.mockReturnValue({ hosts: [hostView('linux-box'), hostView('mac-studio')], isReady: true })
		const switcher = renderHook(() => useWorkingHost())
		const composer = renderHook(() => useWorkingHost())
		act(() => switcher.result.current.set('linux-box'))
		expect(switcher.result.current.id).toBe('linux-box')
		expect(composer.result.current.id).toBe('linux-box')
		expect(savedChoice()).toBe('linux-box')
	})

	it('belongs to one organization', () => {
		useBrowserAuth.mockReturnValue({ user: { id: 'me' }, organizationId: 'other-org' })
		useHosts.mockReturnValue({ hosts: [hostView('linux-box'), hostView('mac-studio')], isReady: true })
		const { result } = renderHook(() => useWorkingHost())
		expect(result.current.id).toBe('linux-box')
	})
})

describe('workingHostState', () => {
	it.each([
		['all', null, 'all'],
		['mac-studio', { online: true }, 'online'],
		['mac-studio', { online: false }, 'offline'],
		['mac-studio', null, 'missing'],
	] as const)('%s with %j is %s', (id, host, expected) => {
		expect(workingHostState(id, host)).toBe(expected)
	})
})
