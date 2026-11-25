import { describe, expect, it } from 'vitest'

import type { ProjectGroup } from '@/minimalist/lib/data'

import { elsewhereHost, maskGroups } from './host-mask'
import type { WorkingHost } from './working-host-store'

function group(key: string, hostIds: string[] | null, projectId: string | null = key): ProjectGroup {
	return { key, name: key, projectId, tasks: [], mine: true, hostIds }
}

describe('maskGroups', () => {
	// The PRD's masking table, one row per sidebar group kind and working host.
	it.each<[string, boolean, ProjectGroup, WorkingHost]>([
		['a project checked out on the working host', true, group('p', ['mac-studio']), 'mac-studio'],
		['a project checked out only on another host', false, group('p', ['mac-studio']), 'linux-box'],
		[
			'a project checked out on several hosts, one of them working',
			true,
			group('p', ['a', 'linux-box']),
			'linux-box',
		],
		['a clone-on-demand project', true, group('p', null), 'linux-box'],
		[
			'a folder group whose sessions ran on the working host',
			true,
			group('dir:app', ['linux-box'], null),
			'linux-box',
		],
		[
			'a folder group whose sessions ran only elsewhere',
			false,
			group('dir:app', ['mac-studio'], null),
			'linux-box',
		],
		['a folder group whose tasks never ran', true, group('other', null, null), 'linux-box'],
		[
			'a workspace group whose sessions ran elsewhere',
			false,
			group('workspace:w', ['mac-studio'], null),
			'linux-box',
		],
		['a checkout-only project on All hosts', true, group('p', ['mac-studio']), 'all'],
		['a folder group that ran elsewhere, on All hosts', true, group('dir:app', ['mac-studio'], null), 'all'],
		['a project checked out on a host that was removed, working there', true, group('p', ['gone']), 'gone'],
	])('%s → visible: %s', (_, visible, entry, working) => {
		expect(maskGroups([entry], working)).toEqual(visible ? [entry] : [])
	})

	it('keeps the remaining groups in order', () => {
		const groups = [group('a', null), group('b', ['mac-studio']), group('c', ['linux-box']), group('d', null)]
		expect(maskGroups(groups, 'linux-box').map((entry) => entry.key)).toEqual(['a', 'c', 'd'])
	})

	it('returns the same list on All hosts', () => {
		const groups = [group('a', ['mac-studio'])]
		expect(maskGroups(groups, 'all')).toBe(groups)
	})
})

describe('elsewhereHost', () => {
	it.each<[string, string | null, WorkingHost, string | null]>([
		['last ran on another host', 'linux-box', 'mac-studio', 'linux-box'],
		['last ran on the working host', 'mac-studio', 'mac-studio', null],
		['never ran', null, 'mac-studio', null],
		['last ran anywhere, on All hosts', 'linux-box', 'all', null],
	])('a task that %s is tagged with %s', (_, latestHostId, working, tag) => {
		expect(elsewhereHost({ latestHostId }, working)).toBe(tag)
	})
})
