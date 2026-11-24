import { Button } from '@devflow/ui/components/button'
import type React from 'react'

interface ToastAction {
	label: string | React.ReactNode
	onClick: (event?: React.MouseEvent<HTMLButtonElement>) => void
}

interface ToastButtonsProps {
	action?: ToastAction
	cancel?: ToastAction
	variant?: 'default' | 'success' | 'error' | 'warning' | 'info'
	toastId?: string
}

const COLOR_CLASSES: Record<NonNullable<ToastButtonsProps['variant']>, { action: string; cancel: string }> = {
	success: {
		action: 'bg-background text-[var(--terminal-success)] border-[var(--terminal-success)] hover:bg-[var(--terminal-success)] hover:text-background focus-visible:border-[var(--terminal-success)] focus-visible:ring-[var(--terminal-success)]/50',
		cancel: 'bg-transparent text-[var(--terminal-success)] border-[var(--terminal-success)] hover:bg-[var(--terminal-success)] hover:text-background focus-visible:border-[var(--terminal-success)] focus-visible:ring-[var(--terminal-success)]/50',
	},
	error: {
		action: 'bg-background text-[var(--terminal-error)] border-[var(--terminal-error)] hover:bg-[var(--terminal-error)] hover:text-background focus-visible:border-[var(--terminal-error)] focus-visible:ring-[var(--terminal-error)]/50',
		cancel: 'bg-transparent text-[var(--terminal-error)] border-[var(--terminal-error)] hover:bg-[var(--terminal-error)] hover:text-background focus-visible:border-[var(--terminal-error)] focus-visible:ring-[var(--terminal-error)]/50',
	},
	warning: {
		action: 'bg-background text-[var(--terminal-warning)] border-[var(--terminal-warning)] hover:bg-[var(--terminal-warning)] hover:text-background focus-visible:border-[var(--terminal-warning)] focus-visible:ring-[var(--terminal-warning)]/50',
		cancel: 'bg-transparent text-[var(--terminal-warning)] border-[var(--terminal-warning)] hover:bg-[var(--terminal-warning)] hover:text-background focus-visible:border-[var(--terminal-warning)] focus-visible:ring-[var(--terminal-warning)]/50',
	},
	info: {
		action: 'bg-background text-[var(--terminal-accent)] border-[var(--terminal-accent)] hover:bg-[var(--terminal-accent)] hover:text-background focus-visible:border-[var(--terminal-accent)] focus-visible:ring-[var(--terminal-accent)]/50',
		cancel: 'bg-transparent text-[var(--terminal-accent)] border-[var(--terminal-accent)] hover:bg-[var(--terminal-accent)] hover:text-background focus-visible:border-[var(--terminal-accent)] focus-visible:ring-[var(--terminal-accent)]/50',
	},
	default: { action: '', cancel: '' },
}

/** Action and cancel buttons for a toast, sharing the width when both show. Sonner dismisses on click. */
export function ToastButtons({ action, cancel, variant = 'default', toastId }: ToastButtonsProps) {
	const hasBothButtons = action && cancel
	const colorClasses = COLOR_CLASSES[variant]

	return (
		<div className="flex gap-2 w-full mt-3">
			{cancel && (
				<Button
					data-button
					data-cancel
					data-toast-id={toastId}
					onClick={(event) => cancel.onClick(event)}
					variant={variant === 'default' ? 'outline' : undefined}
					size="sm"
					className={`${hasBothButtons ? 'flex-1' : 'w-full'} uppercase ${colorClasses.cancel}`}
				>
					{cancel.label}
				</Button>
			)}
			{action && (
				<Button
					data-button
					data-action
					data-toast-id={toastId}
					onClick={(event) => action.onClick(event)}
					variant={variant === 'default' ? 'default' : undefined}
					size="sm"
					className={`${hasBothButtons ? 'flex-1' : 'w-full'} uppercase ${colorClasses.action}`}
				>
					{action.label}
				</Button>
			)}
		</div>
	)
}
