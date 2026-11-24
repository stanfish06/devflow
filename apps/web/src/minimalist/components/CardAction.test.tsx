import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentStateLabel, CardActionButton } from './CardAction'

describe('card action button', () => {
	it('runs without opening its card, and ignores repeated activation until the request settles', async () => {
		let finish: () => void = () => undefined
		const onRun = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const onOpen = vi.fn()
		render(
			<div onClick={onOpen} role="presentation">
				<CardActionButton action={{ kind: 'start' }} taskName="Webhooks" blocker={null} onRun={onRun} />
			</div>,
		)
		const button = screen.getByRole('button', { name: 'Start Webhooks' })
		// Two activations in one render batch must still send only one request.
		act(() => {
			button.click()
			button.click()
		})
		expect(onRun).toHaveBeenCalledExactlyOnceWith({ kind: 'start' })
		expect(onOpen).not.toHaveBeenCalled()
		expect(button).toHaveAttribute('aria-busy', 'true')
		expect(button).toHaveAttribute('aria-disabled', 'true')
		await act(async () => {
			finish()
			await Promise.resolve()
		})
		expect(button).not.toHaveAttribute('aria-busy')
		expect(button).not.toHaveAttribute('aria-disabled')
		fireEvent.click(button)
		expect(onRun).toHaveBeenCalledTimes(2)
		await act(async () => {
			finish()
			await Promise.resolve()
		})
	})

	it('keeps a blocked Start focusable with the reason, and sends nothing', () => {
		const onRun = vi.fn()
		render(
			<CardActionButton
				action={{ kind: 'start' }}
				taskName="Webhooks"
				blocker="laptop is offline"
				onRun={onRun}
			/>,
		)
		const button = screen.getByRole('button', { name: 'Start Webhooks' })
		button.focus()
		expect(button).toHaveFocus()
		expect(button).toHaveAttribute('title', 'laptop is offline')
		expect(button).toHaveAttribute('aria-disabled', 'true')
		fireEvent.click(button)
		expect(onRun).not.toHaveBeenCalled()
	})

	it('renders no button without an action, while the state remains readable', () => {
		render(
			<>
				<CardActionButton action={null} taskName="Webhooks" blocker={null} onRun={vi.fn()} />
				<AgentStateLabel state="finished" />
			</>,
		)
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
		expect(screen.getByText('Finished')).toBeVisible()
	})
})
