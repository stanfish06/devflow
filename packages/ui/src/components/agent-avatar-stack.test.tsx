import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AgentAvatarStack } from './agent-avatar-stack'

describe('AgentAvatarStack', () => {
	it('marks the agent with a neutral robot badge instead of a logo image', () => {
		const { container } = render(
			<AgentAvatarStack authorDisplayName="Ada Lovelace" authorFallbackId="user_1" withTooltip={false} />,
		)
		const badge = screen.getByTestId('agent-avatar-badge')
		expect(badge.querySelector('svg.lucide-bot')).not.toBeNull()
		expect(badge).toHaveClass('bg-muted')
		expect(badge.querySelector('[data-slot="avatar-fallback"]')).toHaveClass('text-muted-foreground')
		// No avatar picture was given and the badge has none of its own, so nothing loads an image.
		expect(container.querySelector('img')).toBeNull()
		// The author's initials still sit under the badge.
		expect(screen.getByText('AL')).toBeInTheDocument()
	})

	it('sizes the badge like the author avatar', () => {
		render(<AgentAvatarStack authorFallbackId="user_1" avatarClassName="size-4" withTooltip={false} />)
		expect(screen.getByTestId('agent-avatar-badge')).toHaveClass('size-4')
	})

	it('keeps the "{Name}\'s agent" tooltip', async () => {
		const { container } = render(<AgentAvatarStack authorDisplayName="Ada Lovelace" authorFallbackId="user_1" />)
		const trigger = container.querySelector('[data-slot="tooltip-trigger"]')
		expect(trigger).not.toBeNull()
		fireEvent.focus(trigger as Element)
		expect(await screen.findByRole('tooltip')).toHaveTextContent("Ada Lovelace's agent")
	})

	it("falls back to \"Someone's agent\" without a display name", async () => {
		const { container } = render(<AgentAvatarStack authorFallbackId="user_1" />)
		fireEvent.focus(container.querySelector('[data-slot="tooltip-trigger"]') as Element)
		expect(await screen.findByRole('tooltip')).toHaveTextContent("Someone's agent")
	})
})
