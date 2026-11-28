import { describe, expect, test } from 'vitest'

import { DraftLaunchSchema } from '../src/api/tasks/draft-launch'
import { CreateTaskV2InputSchema } from '../src/api/tasks/v2/create'

const validInput = {
	taskId: '01900000-0000-7000-8000-000000000001',
	workspaceId: '01900000-0000-7000-8000-000000000002',
	projectId: '01900000-0000-7000-8000-000000000003',
	name: 'Workspace path task',
	slug: 'workspace path [manually-edited]!',
	repositories: [
		{
			remoteUrl: 'https://github.com/org/repo.git',
			repositoryIdentity: 'github.com/org/repo',
			defaultBranch: 'main',
			branch: 'test',
			default: true,
			autoPushBranch: false,
			copyGlobs: [],
		},
	],
	firstSession: { hostId: 'host', text: 'Implement', codingAgent: 'claude', permissionsMode: 'default' },
}

describe('CreateTaskV2InputSchema slug', () => {
	test('requires a slug and trims it', () => {
		expect(CreateTaskV2InputSchema.safeParse({ ...validInput, slug: undefined }).success).toBe(false)
		expect(CreateTaskV2InputSchema.parse({ ...validInput, slug: '  readable-task  ' }).slug).toBe('readable-task')
	})

	test.each(['', '   ', '.', '..', 'nested/path', 'nested\\path', 'nul\0segment', 'x'.repeat(101), '界'.repeat(86)])(
		'rejects unsafe slug %j',
		(slug) => {
			expect(CreateTaskV2InputSchema.safeParse({ ...validInput, slug }).success).toBe(false)
		},
	)

	test('permits manually edited characters within one path segment', () => {
		expect(CreateTaskV2InputSchema.safeParse(validInput).success).toBe(true)
	})
})

describe('task VM sizing', () => {
	test.each(['vmCpus', 'vmMemoryGiB'])('accepts only positive whole %s within PostgreSQL integer range', (field) => {
		for (const value of [0, -1, 2.5, 2 ** 31]) {
			expect(CreateTaskV2InputSchema.safeParse({ ...validInput, [field]: value }).success).toBe(false)
		}
		expect(CreateTaskV2InputSchema.parse({ ...validInput, [field]: 8 })).toHaveProperty(field, 8)
	})
})

test('sized drafts require version 2 and an own VM target', () => {
	const defaultDraft = {
		version: 1,
		prompt: 'Run simulation',
		attachments: [],
		target: { kind: 'project', projectId: validInput.projectId },
		hostId: 'host',
		settings: { agent: 'claude', model: 'opus', effort: null, fastMode: false, permissionsMode: 'default' },
		taskSize: 'large',
		smallAutoAdvance: true,
	}
	expect(DraftLaunchSchema.safeParse(defaultDraft).success).toBe(true)
	expect(DraftLaunchSchema.safeParse({ ...defaultDraft, vmCpus: 8 }).success).toBe(false)
	const sized = { ...defaultDraft, version: 2, vmCpus: 8 }
	expect(DraftLaunchSchema.parse(sized)).toMatchObject({ version: 2, vmCpus: 8 })
	expect(DraftLaunchSchema.safeParse({ ...sized, vmScope: 'shared' }).success).toBe(false)
	expect(DraftLaunchSchema.safeParse({ ...sized, target: { kind: 'directory', path: '/tmp' } }).success).toBe(false)
})
