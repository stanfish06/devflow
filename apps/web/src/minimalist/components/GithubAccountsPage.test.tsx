import { ORPCError } from '@orpc/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GithubAccountsPage } from './GithubAccountsPage'

// jsdom has no modal dialogs; the dialogs only need them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { api, queries, showToast } = vi.hoisted(() => {
	const api = {
		githubAccounts: {
			list: vi.fn(),
			add: vi.fn(),
			replaceToken: vi.fn(),
			remove: vi.fn(),
			setDefault: vi.fn(),
		},
	}
	const queries = {
		githubAccounts: {
			list: {
				key: () => ['githubAccounts', 'list'],
				queryOptions: () => ({
					queryKey: ['githubAccounts', 'list'],
					queryFn: () => api.githubAccounts.list({}),
				}),
			},
		},
	}
	return { api, queries, showToast: vi.fn() }
})

vi.mock('@/orpc/client', () => ({ useApi: () => ({ client: api, queryClient: queries }) }))
vi.mock('@/minimalist/lib/ui-state', () => ({ useUi: () => ({ showToast }) }))

const DAY = 86_400_000
const account = (id: string, login: string, status: 'ok' | 'needs_token' = 'ok') => ({
	id,
	login,
	name: null,
	noreplyEmail: `1+${login}@users.noreply.github.com`,
	status,
	createdAt: Date.now() - 3 * DAY,
})

const WORK = account('work-id', 'stan-work')
const PERSONAL = account('personal-id', 'stan-personal')
const BOT = account('bot-id', 'stan-bot', 'needs_token')

let queryClient: QueryClient

function renderPage() {
	return render(
		<QueryClientProvider client={queryClient}>
			<GithubAccountsPage />
		</QueryClientProvider>,
	)
}

/** The settings row that names `label`. */
const row = async (label: string) => {
	const name = await screen.findByText(label, { selector: 'b' })
	const element = name.closest('.srow')
	if (!(element instanceof HTMLElement)) throw new Error(`No row for ${label}`)
	return within(element)
}

beforeEach(() => {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	api.githubAccounts.list.mockResolvedValue({ accounts: [WORK, PERSONAL, BOT], defaultAccountId: 'work-id' })
	api.githubAccounts.add.mockResolvedValue({ account: account('new-id', 'stan-new') })
	api.githubAccounts.replaceToken.mockResolvedValue({ account: WORK })
	api.githubAccounts.remove.mockResolvedValue({})
	api.githubAccounts.setDefault.mockResolvedValue({})
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe('the accounts list', () => {
	it('shows each account’s login and commit email, and marks the default', async () => {
		renderPage()
		const work = await row('stan-work')
		expect(work.getByText('1+stan-work@users.noreply.github.com · Added 3d ago')).toBeTruthy()
		expect(work.getByText('Default')).toBeTruthy()
		expect(work.queryByRole('button', { name: 'Make default' })).toBeNull()

		const personal = await row('stan-personal')
		expect(personal.getByRole('button', { name: 'Make default' })).toBeEnabled()
		expect(personal.getByRole('button', { name: 'Replace token' })).toBeTruthy()
		expect(personal.getByRole('button', { name: 'Remove' })).toBeTruthy()
	})

	it('flags an account whose token GitHub rejected, and won’t make it the default', async () => {
		renderPage()
		const bot = await row('stan-bot')
		expect(bot.getByText('Needs new token')).toBeTruthy()
		expect(bot.getByRole('button', { name: 'Make default' })).toBeDisabled()
		expect(bot.getByRole('button', { name: 'Replace token' })).toBeEnabled()
	})

	it('offers the host’s own gh login, which is the default until an account is chosen', async () => {
		api.githubAccounts.list.mockResolvedValue({ accounts: [WORK], defaultAccountId: null })
		renderPage()
		const host = await row("Host's own gh login")
		expect(host.getByText('Default')).toBeTruthy()
		expect((await row('stan-work')).getByRole('button', { name: 'Make default' })).toBeTruthy()
	})

	it('never shows a token, only who it belongs to', async () => {
		const { container } = renderPage()
		await row('stan-work')
		expect(container.textContent).not.toMatch(/ghp_|github_pat_[A-Za-z0-9]/)
	})
})

describe('choosing the default', () => {
	it('makes an account the default and refreshes the list', async () => {
		renderPage()
		const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
		fireEvent.click((await row('stan-personal')).getByRole('button', { name: 'Make default' }))
		await waitFor(() => expect(showToast).toHaveBeenCalledWith('stan-personal is now your default'))
		expect(api.githubAccounts.setDefault).toHaveBeenCalledWith(
			{ accountId: 'personal-id' },
			{ context: { silent: true } },
		)
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['githubAccounts', 'list'] })
	})

	it('goes back to the host’s own gh login', async () => {
		renderPage()
		fireEvent.click((await row("Host's own gh login")).getByRole('button', { name: 'Make default' }))
		await waitFor(() => expect(showToast).toHaveBeenCalledWith("Agents now use each host's own gh login"))
		expect(api.githubAccounts.setDefault).toHaveBeenCalledWith({ accountId: null }, { context: { silent: true } })
	})
})

describe('adding an account', () => {
	const openAdd = async () => {
		renderPage()
		fireEvent.click(await screen.findByRole('button', { name: 'Add account…' }))
		return screen.getByRole('dialog', { name: 'Add GitHub account' })
	}

	it('sends the pasted token, masked as it is typed, and names the account it belonged to', async () => {
		const dialog = within(await openAdd())
		const input = dialog.getByLabelText('Add GitHub account')
		expect(input).toHaveAttribute('type', 'password')
		fireEvent.change(input, { target: { value: '  github_pat_new  ' } })
		fireEvent.click(dialog.getByRole('button', { name: 'Add account' }))

		await waitFor(() => expect(showToast).toHaveBeenCalledWith('Added stan-new'))
		expect(api.githubAccounts.add).toHaveBeenCalledWith({ token: 'github_pat_new' }, { context: { silent: true } })
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add GitHub account' })).toBeNull())
	})

	it('keeps the dialog open with the server’s reason when GitHub rejects the token', async () => {
		api.githubAccounts.add.mockRejectedValue(
			new ORPCError('BAD_REQUEST', {
				defined: true,
				data: { message: "GitHub rejected this token. Check that it's pasted in full and hasn't expired." },
			}),
		)
		const dialog = within(await openAdd())
		fireEvent.change(dialog.getByLabelText('Add GitHub account'), { target: { value: 'ghp_bad' } })
		fireEvent.click(dialog.getByRole('button', { name: 'Add account' }))

		expect(await dialog.findByText(/GitHub rejected this token/)).toBeTruthy()
		expect(screen.getByRole('dialog', { name: 'Add GitHub account' })).toBeTruthy()
		expect(showToast).not.toHaveBeenCalled()
	})

	it('says when the server can’t store tokens at all', async () => {
		api.githubAccounts.add.mockRejectedValue(
			new ORPCError('TOKEN_STORAGE_UNAVAILABLE', {
				defined: true,
				data: { message: "This devflow server can't store GitHub tokens: GITHUB_ACCOUNT_TOKEN_KEY isn't set." },
			}),
		)
		const dialog = within(await openAdd())
		fireEvent.change(dialog.getByLabelText('Add GitHub account'), { target: { value: 'ghp_any' } })
		fireEvent.click(dialog.getByRole('button', { name: 'Add account' }))
		expect(await dialog.findByText(/GITHUB_ACCOUNT_TOKEN_KEY isn't set/)).toBeTruthy()
	})

	it('falls back to plain copy for an unexplained failure', async () => {
		api.githubAccounts.add.mockRejectedValue(new Error('network down'))
		const dialog = within(await openAdd())
		fireEvent.change(dialog.getByLabelText('Add GitHub account'), { target: { value: 'ghp_any' } })
		fireEvent.click(dialog.getByRole('button', { name: 'Add account' }))
		expect(await dialog.findByText('Could not add the account. Try again.')).toBeTruthy()
	})
})

describe('replacing a token', () => {
	it('sends the new token for that account', async () => {
		renderPage()
		fireEvent.click((await row('stan-bot')).getByRole('button', { name: 'Replace token' }))
		const dialog = within(screen.getByRole('dialog', { name: "Replace stan-bot's token" }))
		fireEvent.change(dialog.getByLabelText("Replace stan-bot's token"), { target: { value: 'ghp_fresh' } })
		fireEvent.click(dialog.getByRole('button', { name: 'Replace token' }))

		await waitFor(() => expect(showToast).toHaveBeenCalledWith("Replaced stan-bot's token"))
		expect(api.githubAccounts.replaceToken).toHaveBeenCalledWith(
			{ accountId: 'bot-id', token: 'ghp_fresh' },
			{ context: { silent: true } },
		)
	})
})

describe('removing an account', () => {
	it('asks first, then removes it', async () => {
		renderPage()
		fireEvent.click((await row('stan-personal')).getByRole('button', { name: 'Remove' }))
		const dialog = within(screen.getByRole('dialog', { name: 'Remove stan-personal?' }))
		expect(dialog.getByText('devflow deletes its stored token. Nothing on GitHub changes.')).toBeTruthy()
		expect(api.githubAccounts.remove).not.toHaveBeenCalled()

		fireEvent.click(dialog.getByRole('button', { name: 'Remove' }))
		await waitFor(() => expect(showToast).toHaveBeenCalledWith('Removed stan-personal'))
		expect(api.githubAccounts.remove).toHaveBeenCalledWith(
			{ accountId: 'personal-id' },
			{ context: { silent: true } },
		)
	})

	it('warns that removing the default goes back to the host login', async () => {
		renderPage()
		fireEvent.click((await row('stan-work')).getByRole('button', { name: 'Remove' }))
		const dialog = within(screen.getByRole('dialog', { name: 'Remove stan-work?' }))
		expect(dialog.getByText(/agents go back to each host's own gh login/)).toBeTruthy()
		fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
		expect(screen.queryByRole('dialog', { name: 'Remove stan-work?' })).toBeNull()
		expect(api.githubAccounts.remove).not.toHaveBeenCalled()
	})
})
