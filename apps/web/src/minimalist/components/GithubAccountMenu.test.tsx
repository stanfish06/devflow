import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubAccount, GithubAccountPick } from '@/minimalist/lib/github-accounts'
import { MinimalistPortalContext } from '@/minimalist/lib/portal'

import { accountDetail, GithubAccountMenu } from './GithubAccountMenu'

// jsdom has no modal dialogs; the menu only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { navigate, accounts } = vi.hoisted(() => ({
	navigate: vi.fn(),
	accounts: {
		accounts: [] as GithubAccount[],
		defaultAccountId: null as string | null,
	},
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/minimalist/lib/github-accounts', () => ({
	useGithubAccounts: () => ({ ...accounts, projectDefaults: {}, isReady: true, isError: false }),
}))

const account = (id: string, login: string, status: GithubAccount['status'] = 'ok'): GithubAccount => ({
	id,
	login,
	name: null,
	noreplyEmail: `1+${login}@users.noreply.github.com`,
	status,
	createdAt: 0,
})

beforeEach(() => {
	accounts.accounts = [
		account('work', 'stan-work'),
		account('personal', 'stan-personal'),
		account('bot', 'stan-bot', 'needs_token'),
	]
	accounts.defaultAccountId = 'personal'
})

afterEach(() => {
	cleanup()
	navigate.mockClear()
})

function openMenu(props: { value: GithubAccountPick; projectDefaultId?: string; hostName?: string }) {
	const onPick = vi.fn()
	const onClose = vi.fn()
	// A real trigger, so the menu places itself and shows.
	const anchor = { current: document.createElement('span') }
	render(
		<MinimalistPortalContext value={document.body}>
			<GithubAccountMenu anchor={anchor} open onPick={onPick} onClose={onClose} {...props} />
		</MinimalistPortalContext>,
	)
	return { onPick, onClose }
}

const item = (name: RegExp) => screen.getByRole('button', { name })

describe('GithubAccountMenu', () => {
	it('lists your accounts, then the host login, then a way to manage them', () => {
		openMenu({ value: 'work', projectDefaultId: 'work', hostName: 'mac-studio' })
		expect(screen.getByText('Push and open PRs as')).toBeInTheDocument()
		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			expect.stringMatching(/stan-workProject default✓$/),
			expect.stringMatching(/stan-personalYour default$/),
			expect.stringMatching(/stan-botNeeds new token$/),
			"Host's own gh loginWhatever mac-studio is signed in as",
			'Manage GitHub accounts…',
		])
	})

	it('greys out an account whose token GitHub rejected', () => {
		const { onPick } = openMenu({ value: 'work' })
		fireEvent.click(item(/^stan-bot/))
		expect(item(/^stan-bot/)).toBeDisabled()
		expect(onPick).not.toHaveBeenCalled()
	})

	it.each([
		[/^stan-personal/, 'personal'],
		[/^Host's own gh login/, null],
	])('picks %s, then closes', (name, pick) => {
		const { onPick, onClose } = openMenu({ value: 'work' })
		fireEvent.click(item(name))
		expect(onPick).toHaveBeenCalledWith(pick)
		expect(onClose).toHaveBeenCalled()
	})

	it("checks the host login when it's in use, and says when it's your default", () => {
		accounts.defaultAccountId = null
		openMenu({ value: null })
		const host = item(/^Host's own gh login/)
		expect(host).toHaveTextContent('Whatever each host is signed in as · your default')
		expect(host).toHaveTextContent('✓')
	})

	it('offers only the host login when you have no accounts', () => {
		accounts.accounts = []
		accounts.defaultAccountId = null
		openMenu({ value: null })
		expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
			"Host's own gh loginWhatever each host is signed in as✓",
			'Manage GitHub accounts…',
		])
	})

	it('goes to Settings → GitHub accounts', () => {
		const { onClose } = openMenu({ value: 'work' })
		fireEvent.click(item(/^Manage GitHub accounts/))
		expect(onClose).toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledWith({ to: '/settings/github-accounts' })
	})
})

describe('accountDetail', () => {
	it.each([
		[account('a', 'a'), { projectDefaultId: 'a', defaultAccountId: 'a' }, 'Project default · Your default'],
		[account('a', 'a'), { projectDefaultId: 'a', defaultAccountId: null }, 'Project default'],
		[account('a', 'a'), { defaultAccountId: 'a' }, 'Your default'],
		[account('a', 'a'), { defaultAccountId: 'b' }, undefined],
		[account('a', 'a', 'needs_token'), { projectDefaultId: 'a', defaultAccountId: 'a' }, 'Needs new token'],
	])('describes %o with %o as %s', (subject, defaults, expected) => {
		expect(accountDetail(subject, defaults)).toBe(expected)
	})
})
