import { describe, expect, it } from 'vitest'

import { type GithubAccount, githubAccountLabel, pickOf, resolveGithubAccount } from './github-accounts'

const account = (id: string): GithubAccount => ({
	id,
	login: `stan-${id}`,
	name: null,
	noreplyEmail: `1+stan-${id}@users.noreply.github.com`,
	status: 'ok',
	createdAt: 0,
})

const accounts = [account('task'), account('project'), account('default')]

describe('resolveGithubAccount', () => {
	it.each([
		['the task pick', { task: 'task', project: 'project', defaultAccountId: 'default' }, 'stan-task', 'task'],
		["the task's host login", { task: null, project: 'project', defaultAccountId: 'default' }, 'host', 'task'],
		[
			'the project default',
			{ task: undefined, project: 'project', defaultAccountId: 'default' },
			'stan-project',
			'project',
		],
		[
			'your default',
			{ task: undefined, project: undefined, defaultAccountId: 'default' },
			'stan-default',
			'default',
		],
		["the host's login", { task: undefined, project: undefined, defaultAccountId: null }, 'host', 'host'],
		[
			'the next level past a removed account',
			{ task: 'gone', project: 'gone', defaultAccountId: 'default' },
			'stan-default',
			'default',
		],
		[
			"the host's login past a removed default",
			{ task: undefined, project: undefined, defaultAccountId: 'gone' },
			'host',
			'host',
		],
	] as const)('uses %s', (_name, levels, login, source) => {
		const resolved = resolveGithubAccount({ accounts, ...levels })
		expect(resolved.account === 'host' ? 'host' : resolved.account.login).toBe(login)
		expect(resolved.source).toBe(source)
	})

	it('names the pick and the chip label for an account and for the host login', () => {
		const picked = resolveGithubAccount({ accounts, task: 'task', defaultAccountId: null })
		const host = resolveGithubAccount({ accounts, task: null, defaultAccountId: 'default' })
		expect([pickOf(picked), githubAccountLabel(picked)]).toEqual(['task', 'stan-task'])
		expect([pickOf(host), githubAccountLabel(host)]).toEqual([null, 'Host gh login'])
	})
})
