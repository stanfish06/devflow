import { describe, expect, test } from 'vitest'

import type { HostStateInput, HostStateRow } from './host-state'
import { deriveSessionHostState, deriveSessionHostView } from './session-host-state'

const NOW = 1_000_000

function row(overrides: Partial<HostStateRow> = {}): HostStateRow {
	return { status: 'online', last_seen: BigInt(NOW), update_state: null, ...overrides }
}

function sessionHost(overrides: Partial<HostStateInput>, isLocal = overrides.isLocal ?? false) {
	const state = deriveSessionHostState({ host: row(), isLocal, nowMs: NOW, ...overrides })
	return { state, ...deriveSessionHostView(state) }
}

const offlineRow = row({ status: 'offline', last_seen: BigInt(NOW - 60_000) })

describe('session page host state', () => {
	test('this device is offline when its row is offline', () => {
		expect(sessionHost({ host: offlineRow, isLocal: true })).toEqual({
			state: 'offline',
			isHostOffline: true,
			isHostStarting: false,
			isHostUpdating: false,
		})
	})

	test('a remote offline host is offline without a launch action', () => {
		expect(sessionHost({ host: offlineRow })).toEqual({
			state: 'offline',
			isHostOffline: true,
			isHostStarting: false,
			isHostUpdating: false,
		})
	})

	test('a removed remote host reads as offline', () => {
		expect(sessionHost({ host: null }).state).toBe('offline')
	})

	test('a host installing an update is updating and keeps the input open', () => {
		expect(sessionHost({ host: row({ update_state: 'installing' }), isLocal: true })).toEqual({
			state: 'updating',
			isHostOffline: false,
			isHostStarting: false,
			isHostUpdating: true,
		})
	})

	test('a recorded online host with a lagging heartbeat stays online, so the input and approvals stay open', () => {
		const laggingRow = row({ last_seen: BigInt(NOW - 60_000) })
		expect(sessionHost({ host: laggingRow })).toEqual({
			state: 'online',
			isHostOffline: false,
			isHostStarting: false,
			isHostUpdating: false,
		})
		expect(sessionHost({ host: laggingRow, isLocal: true }).state).toBe('online')
	})

	test('an unknown state shows nothing', () => {
		expect(deriveSessionHostView(null)).toEqual({
			isHostOffline: false,
			isHostStarting: false,
			isHostUpdating: false,
		})
	})
})
