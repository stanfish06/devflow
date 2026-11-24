import * as React from 'react'
import { Textarea } from './textarea'
import { cn } from '@devflow/ui/lib/utils'

export type SensitiveTextareaProps = React.ComponentProps<typeof Textarea>

/**
 * SensitiveTextarea is a wrapper around Textarea that marks its content as sensitive with the
 * `ph-no-capture` class.
 *
 * Use this for:
 * - User prompts and messages
 * - Code snippets
 * - File contents
 * - Any other sensitive user input
 */
export const SensitiveTextarea = React.forwardRef<HTMLTextAreaElement, SensitiveTextareaProps>(
  ({ className, ...props }, ref) => {
    return <Textarea ref={ref} className={cn('ph-no-capture', className)} {...props} />
  },
)

SensitiveTextarea.displayName = 'SensitiveTextarea'
