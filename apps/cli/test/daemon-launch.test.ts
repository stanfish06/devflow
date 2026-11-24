import { describe, expect, it } from 'vitest'

import { formatDaemonLaunchError } from '../src/commands/daemon-launch'

describe('daemon launch errors', () => {
	it('prefixes the error message', () => {
		expect(formatDaemonLaunchError(new Error('Connection failed'))).toBe('Failed to launch daemon: Connection failed')
	})
})
