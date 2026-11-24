import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { getHostIdFilePath } from '../src/lib/host-id'

describe('getHostIdFilePath', () => {
	test('uses the shared host ID outside a devstack', () => {
		expect(getHostIdFilePath('/tmp/devflow', undefined)).toBe(join('/tmp/devflow', 'host_id'))
	})

	test('uses the daemon-compatible stack-scoped host ID in a devstack', () => {
		expect(getHostIdFilePath('/tmp/devflow', 'stack-one')).toBe(join('/tmp/devflow', 'host_id_stack-one'))
	})
})
