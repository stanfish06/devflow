import { RPI_SLASH_COMMANDS } from '@devflow/ui/constants/rpi-skills'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/hooks/stores/settingsStore'
import { activeViewportFileDropHandler } from '@/lib/viewport-file-drop'
import type { SlashCommand } from '@/minimalist/lib/data'
import type { ComposerSettings } from '@/minimalist/lib/models'
import { MinimalistPortalContext } from '@/minimalist/lib/portal'
import type { ComposerAttachments } from '@/minimalist/lib/use-attachments'

import { Composer } from './Composer'

// The split Start button is real; its menu needs the modal API jsdom lacks.
vi.mock('@/minimalist/components/ComposerControls', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/minimalist/components/ComposerControls')>()),
	AddButton: () => null,
	AttachmentChips: () => null,
	ContextMeter: () => null,
}))
vi.mock('@/minimalist/lib/modal', () => ({
	openModal: (dialog: HTMLDialogElement | null) => {
		dialog?.setAttribute('open', '')
		return () => dialog?.removeAttribute('open')
	},
}))
vi.mock('@/minimalist/components/ModelPicker', () => ({ ModelPicker: () => null, PermissionPicker: () => null }))
vi.mock('@/minimalist/lib/mentions', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/minimalist/lib/mentions')>()),
	useMentions: (query: string | null) =>
		query === null
			? []
			: [
					{
						key: 'research',
						label: 'Research',
						detail: 'Task document',
						insert: '@.devflow/tasks/test/research.md',
					},
				],
}))

const commands: SlashCommand[] = RPI_SLASH_COMMANDS.map((command) => ({ ...command, kind: 'skill' }))
const settings: ComposerSettings = {
	agent: 'claude',
	model: 'opus',
	effort: null,
	fastMode: false,
	permissionsMode: 'default',
}
const scrollIntoView = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
	Element.prototype.scrollIntoView = scrollIntoView
	useSettingsStore.setState({ sendMessageKeybinding: 'enter' })
})

function Harness({ onSubmit, options = commands }: { onSubmit: (value: string) => void; options?: SlashCommand[] }) {
	const [value, setValue] = useState('')
	return (
		<Composer
			value={value}
			onChange={setValue}
			onSubmit={() => onSubmit(value)}
			placeholder="Ask the agent to do anything"
			settings={settings}
			onSettingsChange={() => {}}
			catalog={{ models: [], codexSignedOut: false }}
			commands={options}
			mentionScope={{ taskId: 'task' }}
		/>
	)
}

function type(value: string) {
	const input = screen.getByRole('textbox', { name: 'Message the agent' })
	fireEvent.change(input, { target: { value, selectionStart: value.length } })
	return input
}

describe('minimalist composer autocomplete', () => {
	it('lists every bundled RPI entry and reaches entries past the former eight-result limit with the keyboard', () => {
		const submit = vi.fn()
		render(<Harness onSubmit={submit} />)
		const input = type('/rpi:')
		const rows = screen.getAllByRole('option')
		expect(rows).toHaveLength(27)
		expect(rows.map((row) => row.querySelector('.mono')?.textContent)).toEqual(
			expect.arrayContaining(RPI_SLASH_COMMANDS.map((command) => command.name)),
		)
		fireEvent.keyDown(input, { key: 'ArrowUp' })
		const last = rows.at(-1)
		expect(last).toHaveAttribute('aria-selected', 'true')
		expect(input).toHaveAttribute('aria-activedescendant', last?.id)
		expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
		const picked = RPI_SLASH_COMMANDS.find((command) => command.name === last?.querySelector('.mono')?.textContent)
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(input).toHaveValue(`use the ${(picked?.insertText ?? picked?.name)?.slice(1)} skill\n\n`)
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
		expect(submit).not.toHaveBeenCalled()
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(submit).toHaveBeenCalledOnce()
	})

	it('filters and selects a legacy alias by pointer using its canonical skill instruction', () => {
		const submit = vi.fn()
		render(<Harness onSubmit={submit} />)
		const input = type('/rpi:create-out')
		expect(screen.getAllByRole('option')).toHaveLength(1)
		fireEvent.mouseDown(screen.getByRole('option', { name: /^\/rpi:create-outline/ }))
		expect(input).toHaveValue('use the rpi:create-structure-outline skill\n\n')
		expect(submit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: 'Send' }))
		expect(submit).toHaveBeenCalledWith('use the rpi:create-structure-outline skill\n\n')
	})

	it('keeps system commands as slash text and consumes Tab without sending', () => {
		const submit = vi.fn()
		render(
			<Harness
				onSubmit={submit}
				options={[{ name: '/compact', source: 'bundled', kind: 'command', startOfMessageOnly: true }]}
			/>,
		)
		const input = type('/comp')
		fireEvent.keyDown(input, { key: 'Tab' })
		expect(input).toHaveValue('/compact ')
		expect(submit).not.toHaveBeenCalled()
	})

	it('leaves Enter alone during composition and Shift+Enter while a slash list is open', () => {
		const submit = vi.fn()
		render(<Harness onSubmit={submit} />)
		const input = type('/rpi:create-out')
		fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
		expect(input).toHaveValue('/rpi:create-out')
		expect(submit).not.toHaveBeenCalled()
	})

	it('keeps file/document mentions and unmatched slash text on their existing input and send paths', () => {
		const submit = vi.fn()
		render(<Harness onSubmit={submit} />)
		const input = type('Read @research')
		fireEvent.keyDown(input, { key: 'Tab' })
		expect(input).toHaveValue('Read @.devflow/tasks/test/research.md ')
		expect(submit).not.toHaveBeenCalled()
		type('/home/pepijn')
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(submit).toHaveBeenCalledWith('/home/pepijn')
	})
})

describe('minimalist composer file drops', () => {
	function renderWith(attachments: ComposerAttachments | undefined, disabled = false) {
		return render(
			<Composer
				value=""
				onChange={() => {}}
				onSubmit={() => {}}
				placeholder="Ask the agent to do anything"
				disabled={disabled}
				attachments={attachments}
				settings={settings}
				onSettingsChange={() => {}}
				catalog={{ models: [], codexSignedOut: false }}
				mentionScope={{ taskId: 'task' }}
			/>,
		)
	}
	const files = () => [new File(['png'], 'shot.png', { type: 'image/png' })]

	it('takes a file dropped anywhere in the window while it can attach', () => {
		const add = vi.fn()
		const view = renderWith({ add, metadata: [] } as unknown as ComposerAttachments)
		const dropped = files()
		expect(activeViewportFileDropHandler()).not.toBeNull()
		activeViewportFileDropHandler()?.(dropped)
		expect(add).toHaveBeenCalledExactlyOnceWith(dropped)
		view.unmount()
		expect(activeViewportFileDropHandler()).toBeNull()
	})

	it('leaves drops alone without attachments or while disabled', () => {
		const add = vi.fn()
		const view = renderWith(undefined)
		expect(activeViewportFileDropHandler()).toBeNull()
		view.unmount()
		renderWith({ add, metadata: [] } as unknown as ComposerAttachments, true)
		expect(activeViewportFileDropHandler()).toBeNull()
	})
})

describe('minimalist composer with sending off', () => {
	it('takes typing but not sending, and says why on the send button', () => {
		const onSubmit = vi.fn()
		function Blocked() {
			const [value, setValue] = useState('')
			return (
				<Composer
					value={value}
					onChange={setValue}
					onSubmit={onSubmit}
					placeholder="Laptop is offline"
					settings={settings}
					onSettingsChange={() => {}}
					catalog={{ models: [], codexSignedOut: false }}
					submitDisabled
					submitBlocked="Start the daemon on Laptop to send"
				/>
			)
		}
		render(<Blocked />)

		const input = type('still here')
		expect(input).toHaveProperty('disabled', false)
		expect(input).toHaveProperty('value', 'still here')
		fireEvent.keyDown(input, { key: 'Enter' })
		const send = screen.getByRole('button', { name: 'Send' })
		expect(send).toHaveProperty('disabled', true)
		expect(send.getAttribute('title')).toBe('Start the daemon on Laptop to send')
		expect(onSubmit).not.toHaveBeenCalled()
	})
})

describe('minimalist composer that can save a draft', () => {
	function Drafting({
		onSubmit,
		onSaveDraft,
		submitDisabled = false,
	}: {
		onSubmit: () => void
		onSaveDraft: () => void
		submitDisabled?: boolean
	}) {
		const [value, setValue] = useState('')
		return (
			<MinimalistPortalContext value={document.body}>
				<Composer
					value={value}
					onChange={setValue}
					onSubmit={onSubmit}
					onSaveDraft={onSaveDraft}
					submitLabel="Start"
					placeholder="Ask the agent to do anything"
					settings={settings}
					onSettingsChange={() => {}}
					catalog={{ models: [], codexSignedOut: false }}
					submitDisabled={submitDisabled}
				/>
			</MinimalistPortalContext>
		)
	}

	it('starts on Enter and on its primary half', () => {
		const onSubmit = vi.fn()
		const onSaveDraft = vi.fn()
		render(<Drafting onSubmit={onSubmit} onSaveDraft={onSaveDraft} />)
		const input = type('Add retries')
		fireEvent.keyDown(input, { key: 'Enter' })
		fireEvent.click(screen.getByRole('button', { name: 'Start' }))
		expect(onSubmit).toHaveBeenCalledTimes(2)
		expect(onSaveDraft).not.toHaveBeenCalled()
	})

	it('saves a draft from the caret menu and with ⌘S or Ctrl+S, but not with nothing to save', () => {
		const onSubmit = vi.fn()
		const onSaveDraft = vi.fn()
		render(<Drafting onSubmit={onSubmit} onSaveDraft={onSaveDraft} />)
		const input = screen.getByRole('textbox', { name: 'Message the agent' })
		fireEvent.keyDown(input, { key: 's', metaKey: true })
		expect(onSaveDraft).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeDisabled()

		type('Add retries')
		fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }))
		const save = screen.getByRole('button', { name: /^Save as draft/ })
		expect(save).toHaveTextContent('⌘S')
		expect(screen.getByRole('button', { name: /^Start agent/ })).toHaveTextContent('↵')
		fireEvent.click(save)
		expect(onSaveDraft).toHaveBeenCalledOnce()
		expect(screen.queryByRole('button', { name: /^Save as draft/ })).not.toBeInTheDocument()

		const meta = fireEvent.keyDown(input, { key: 's', metaKey: true })
		fireEvent.keyDown(input, { key: 'S', ctrlKey: true })
		expect(meta).toBe(false) // the browser's Save Page never opens
		expect(onSaveDraft).toHaveBeenCalledTimes(3)
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it('saves while starting is blocked, such as for an offline host', () => {
		const onSubmit = vi.fn()
		const onSaveDraft = vi.fn()
		render(<Drafting onSubmit={onSubmit} onSaveDraft={onSaveDraft} submitDisabled />)
		const input = type('Later')
		expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
		fireEvent.keyDown(input, { key: 'Enter' })
		fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }))
		expect(screen.getByRole('button', { name: /^Start agent/ })).toBeDisabled()
		fireEvent.click(screen.getByRole('button', { name: /^Save as draft/ }))
		fireEvent.keyDown(input, { key: 's', metaKey: true })
		expect(onSaveDraft).toHaveBeenCalledTimes(2)
		expect(onSubmit).not.toHaveBeenCalled()
	})
})
