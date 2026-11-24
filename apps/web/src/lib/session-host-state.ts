import { deriveHostState, type HostState, type HostStateInput } from '@/lib/host-state'

export type SessionHostState = Exclude<HostState, 'removed'>

export interface SessionHostView {
	isHostOffline: boolean
	isHostStarting: boolean
	isHostUpdating: boolean
}

export function deriveSessionHostState(input: HostStateInput): SessionHostState {
	const state = deriveHostState(input)
	if (state === 'removed') return 'offline'
	const recordedOnline = input.host?.status === 'online'
	return state === 'offline' && recordedOnline ? 'online' : state
}

export function deriveSessionHostView(state: SessionHostState | null): SessionHostView {
	const isHostOffline = state === 'offline'
	return {
		isHostOffline,
		isHostStarting: state === 'starting',
		isHostUpdating: state === 'updating',
	}
}
