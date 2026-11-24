import { describe, expect, it } from 'vitest'

import { generatePrefixedTaskSlug, TASK_SLUG_MAX_LENGTH } from '@/lib/task-slug'
import { githubFullName, type Ticket, ticketFields, withTicket } from '@/minimalist/lib/tickets'

const issue: Ticket = {
	provider: 'github',
	ticketId: '42',
	name: '[acme/app#42] Fix',
	slug: 'acme-app-42-fix',
	url: 'https://github.com/acme/app/issues/42',
	githubRepository: {
		connectionId: 'c1',
		repositoryId: '7',
		fullName: 'acme/app',
		accountLogin: 'acme',
		private: false,
		archived: false,
	},
}

describe('withTicket', () => {
	it('points the agent at the imported issue after the prompt', () => {
		expect(withTicket('Keep it small', 'acme-app-42-fix', issue)).toBe(
			'Keep it small\n\nSee @.devflow/tasks/acme-app-42-fix/acme-app-42.md',
		)
		expect(withTicket('Hi', 'x', null)).toBe('Hi')
	})

	it('names the issue by repository and number without a prompt', () => {
		expect(withTicket('', 'acme-app-42-fix', issue)).toBe(
			'Work on acme/app#42. See @.devflow/tasks/acme-app-42-fix/acme-app-42.md',
		)
	})
})

describe('GitHub ticket slug length', () => {
	it('keeps the slug within the server limit for a long issue title', () => {
		const longTitle =
			'implement comprehensive end to end testing framework for all microservices across the platform with full coverage'
		const fullName = 'my-organization/my-repository'
		const issueNumber = 42
		const slug = generatePrefixedTaskSlug(`${fullName.replace('/', '-')}-${issueNumber}-`.toLowerCase(), longTitle)
		expect(slug.length).toBeLessThanOrEqual(TASK_SLUG_MAX_LENGTH)
		expect(slug).toMatch(/^my-organization-my-repository-42-/)
		expect(slug).not.toMatch(/-$/)
	})
})

describe('ticketFields', () => {
	it('sends the issue and its repository', () => {
		expect(ticketFields(null)).toEqual({})
		expect(ticketFields(issue)).toMatchObject({
			ticketProvider: 'github',
			ticketId: '42',
			githubConnectionId: 'c1',
			ticketRepositoryId: '7',
			ticketRepositoryFullName: 'acme/app',
		})
	})

	it('reads owner/name from a GitHub project identity', () => {
		expect(githubFullName('github.com/acme/app')).toBe('acme/app')
		expect(githubFullName('gitlab.com/acme/app')).toBeNull()
		expect(githubFullName(undefined)).toBeNull()
	})
})
