import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MinimalistPortalContext } from '@/minimalist/lib/portal'
import { resetWorkingHostStoresForTests } from '@/minimalist/lib/working-host-store'

import { WorkingHostSwitcher } from './WorkingHostSwitcher'

// jsdom has no modal dialogs; the menu only needs them to open.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
	this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
	this.open = false
}

const { useHosts, useBrowserAuth } = vi.hoisted(() => ({ useHosts: vi.fn(), useBrowserAuth: vi.fn() }))
vi.mock('@/minimalist/lib/data', () => ({ useHosts }))
vi.mock('@/hooks/use-browser-auth', () => ({ useBrowserAuth }))

const HOUR = 3_600_000
const STORAGE_KEY = 'working-host:v1:org:me'

function limits(fiveHour: number, week: number) {
	const resets_at = Date.now() + HOUR
	return {
		checked_at: Date.now(),
		available: true,
		subscription_type: 'max',
		windows: { five_hour: { used_percent: fiveHour, resets_at }, seven_day: { used_percent: week, resets_at } },
	}
}

function hostView(id: string, online = true, usage?: ReturnType<typeof limits>) {
	return {
		host: { host_id: id, coding_agent_usage_limits: usage ? { claude: usage } : undefined },
		name: id,
		online,
		lastSeen: Date.now() - 2 * 24 * HOUR,
	}
}

const HOSTS = [
	hostView('mac-studio', true, limits(42, 81)),
	hostView('linux-box', true, limits(10, 33)),
	hostView('old-laptop', false),
]

beforeEach(() => {
	localStorage.clear()
	resetWorkingHostStoresForTests()
	useBrowserAuth.mockReturnValue({ user: { id: 'me' }, organizationId: 'org' })
	useHosts.mockReturnValue({ hosts: HOSTS, isReady: true })
})

afterEach(cleanup)

function renderSwitcher() {
	return render(
		<MinimalistPortalContext value={document.body}>
			<WorkingHostSwitcher />
		</MinimalistPortalContext>,
	)
}

function openMenu() {
	fireEvent.click(screen.getByRole('button', { name: /^Working host:/ }))
}

describe('the working-host switcher', () => {
	it('starts on the first online host on a new device', () => {
		renderSwitcher()
		expect(screen.getByRole('button', { name: 'Working host: mac-studio' })).toBeInTheDocument()
	})

	it('lists all hosts, then each host with its tightest usage, or when it was last seen', () => {
		renderSwitcher()
		openMenu()
		const rows = screen.getAllByRole('button').filter((button) => button.classList.contains('mi'))
		expect(rows.map((row) => row.querySelector('.lines > div')?.textContent)).toEqual([
			'All hosts',
			'mac-studio',
			'linux-box',
			'old-laptop',
		])
		expect(rows[1]).toHaveTextContent('7-day 81% used')
		// Usage only makes the summary once a window nears its limit.
		expect(rows[2]).toHaveTextContent('Online')
		expect(rows[3]).toHaveTextContent('last seen 2d ago')
	})

	it('shows full usage meters for the selected host only', () => {
		const { baseElement } = renderSwitcher()
		openMenu()
		expect(baseElement.querySelectorAll('.usage')).toHaveLength(1)
		expect(baseElement.querySelector('.usage')).toHaveTextContent('5-hour')
		expect(baseElement.querySelector('.usage .meter.high')).not.toBeNull()
	})

	it('remembers a picked host and closes', () => {
		renderSwitcher()
		openMenu()
		fireEvent.click(screen.getByRole('button', { name: /^linux-box/ }))
		expect(screen.getByRole('button', { name: 'Working host: linux-box' })).toBeInTheDocument()
		expect(screen.queryByText('Working host')).not.toBeInTheDocument()
		expect(localStorage.getItem(STORAGE_KEY)).toContain('linux-box')
		cleanup()
		resetWorkingHostStoresForTests()
		renderSwitcher()
		expect(screen.getByRole('button', { name: 'Working host: linux-box' })).toBeInTheDocument()
	})

	it('turns masking off with "All hosts"', () => {
		const { baseElement } = renderSwitcher()
		openMenu()
		fireEvent.click(screen.getByRole('button', { name: /^All hosts/ }))
		expect(screen.getByRole('button', { name: 'Working host: All hosts' })).toBeInTheDocument()
		openMenu()
		expect(baseElement.querySelector('.usage')).toBeNull()
	})

	it('can pick an offline host, which stays chosen and says it is offline', () => {
		renderSwitcher()
		openMenu()
		fireEvent.click(screen.getByRole('button', { name: /^old-laptop/ }))
		const button = screen.getByRole('button', { name: 'Working host: old-laptop, offline' })
		expect(button.querySelector('.dot.off')).not.toBeNull()
		expect(button).toHaveTextContent('offline')
	})

	it('names a removed host by its short id and keeps it', () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { choice: '0123456789abcdef' }, version: 0 }))
		renderSwitcher()
		expect(screen.getByRole('button', { name: 'Working host: 01234567 (removed)' })).toBeInTheDocument()
		openMenu()
		expect(screen.getByRole('button', { name: /^01234567 \(removed\)/ })).toBeDisabled()
	})

	it('starts on all hosts when none is online', () => {
		useHosts.mockReturnValue({ hosts: [hostView('old-laptop', false)], isReady: true })
		renderSwitcher()
		expect(screen.getByRole('button', { name: 'Working host: All hosts' })).toBeInTheDocument()
	})
})
