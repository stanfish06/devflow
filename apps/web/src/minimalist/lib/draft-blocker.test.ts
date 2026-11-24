import { describe, expect, it } from 'vitest'

import { NEWER_DRAFT_ERROR } from '@/minimalist/lib/launch-form'

import { startBlocker } from './draft-blocker'

const projectId = '019ab7c2-4f1e-7000-8000-0000000000aa'

function draft(overrides: Record<string, unknown> = {}) {
	return {
		task: {
			draft_launch: {
				version: 1,
				prompt: 'Later',
				attachments: [],
				target: { kind: 'project', projectId },
				hostId: 'laptop',
				settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'default' },
				taskSize: 'unknown',
				smallAutoAdvance: true,
				...overrides,
			},
		},
	}
}

const host = (id: string, online = true) => ({ host: { host_id: id }, name: `stan-${id}`, online })
const projects = [{ id: projectId }]

describe('startBlocker', () => {
	it('lets a draft start on its own online host, in its project', () => {
		expect(startBlocker(draft(), [host('laptop')], projects)).toBeNull()
		expect(
			startBlocker(draft({ target: { kind: 'directory', path: '/code/app' } }), [host('laptop')], undefined),
		).toBeNull()
	})

	it.each([
		[
			'its host is offline, even with another online',
			[host('laptop', false), host('vm')],
			projects,
			'stan-laptop is offline',
		],
		[
			'its host is no longer registered',
			[host('vm')],
			projects,
			"This draft's host is no longer registered. Choose another host.",
		],
		['no daemon has ever run', [], projects, "This draft's host is no longer registered. Choose another host."],
		[
			'its project is gone',
			[host('laptop')],
			[],
			"This draft's project is no longer available. Choose another project.",
		],
		['projects are still loading', [host('laptop')], undefined, 'Loading…'],
	])('blocks Start when %s', (_label, hosts, projectList, reason) => {
		expect(startBlocker(draft(), hosts, projectList)).toBe(reason)
	})

	it('asks for a host when the draft was saved without one', () => {
		expect(startBlocker(draft({ hostId: '' }), [host('vm')], projects)).toBe('Choose a host for this draft')
		expect(startBlocker(draft({ hostId: '' }), [], projects)).toBe('Start a daemon to launch sessions')
	})

	it('says so when a newer version saved the draft, rather than guessing', () => {
		expect(startBlocker(draft({ version: 2 }), [host('laptop')], projects)).toBe(NEWER_DRAFT_ERROR)
	})
})
