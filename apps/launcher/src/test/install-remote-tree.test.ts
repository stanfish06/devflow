import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	closeSync,
	fstatSync,
	statSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { installRemoteTree, REMOTE_STAGING } from '../lib/install-remote-tree'

const fixtures: string[] = []
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

test('redeploy publishes skills through the original mounted directory and removes retired files', () => {
	const target = mkdtempSync(join(tmpdir(), 'devflow-remote-test-'))
	fixtures.push(target)
	const archive = join(target, REMOTE_STAGING, 'archive')
	const plugin = 'apps/workflow-skills'
	const skill = 'skills/iterate-tdd/SKILL.md'
	const put = (root: string, name: string, text: string) => {
		const path = join(root, name)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, text)
	}
	put(target, join(plugin, 'retired.md'), 'old skill')
	put(target, join(plugin, skill), 'old revision')
	put(target, 'node_modules/dependency', 'installed')
	put(archive, join(plugin, skill), 'updated revision')
	put(archive, 'bin/cli', 'executable')
	symlinkSync('../../bin/cli', join(archive, plugin, 'command'))
	const handle = openSync(join(target, plugin), 'r')
	try {
		installRemoteTree(archive, target)
		expect(statSync(join(target, plugin)).ino).toBe(fstatSync(handle).ino)
		expect(readFileSync(join(target, plugin, skill), 'utf8')).toBe('updated revision')
		expect(readFileSync(join(target, plugin, 'command'), 'utf8')).toBe('executable')
		expect(existsSync(join(target, plugin, 'retired.md'))).toBe(false)
		expect(readFileSync(join(target, 'node_modules/dependency'), 'utf8')).toBe('installed')
	} finally {
		closeSync(handle)
	}
})
