import { lazy, memo, Suspense } from 'react'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { logger } from '@/lib/logger'

import type { MarkdownRendererFullProps } from './MarkdownRendererFull'
import { RawContentFallback } from './RawContentFallback'

export interface MarkdownRendererProps {
	content: string
	preserveSingleLineBreaks?: boolean
	preserveXmlTags?: boolean
	streaming?: boolean
	artifactMentions?: boolean
}

/**
 * Lazy load the Streamdown-based renderer (shiki, katex, and the markdown pipeline
 * live in their own chunk). If the import fails, return a component that throws so
 * the error boundary can catch it and fall back to raw text.
 */
const MarkdownRendererFull = lazy<React.ComponentType<MarkdownRendererFullProps>>(() =>
	import('./MarkdownRendererFull').catch((error) => {
		logger.error('MarkdownRendererFull failed to load', error)

		return {
			default: (_props: MarkdownRendererFullProps): React.ReactNode => {
				throw new Error(`Markdown renderer failed to load: ${error.message}`)
			},
		}
	}),
)

/**
 * Main MarkdownRenderer component.
 *
 * Layer 1: Streamdown renderer (lazy loaded) - GFM, math, shiki code blocks,
 *          block-level memoization for streaming content
 * Layer 2: Raw content display - pre-formatted plaintext
 */
export const MarkdownRenderer = memo(
	({ content, preserveSingleLineBreaks, preserveXmlTags, streaming, artifactMentions }: MarkdownRendererProps) => (
		<ErrorBoundary
			variant="markdown"
			componentName="MarkdownRenderer"
			fallback={() => <RawContentFallback content={content} />}
		>
			<Suspense fallback={<RawContentFallback content={content} />}>
				<MarkdownRendererFull
					content={content}
					preserveSingleLineBreaks={preserveSingleLineBreaks}
					preserveXmlTags={preserveXmlTags}
					streaming={streaming}
					artifactMentions={artifactMentions}
				/>
			</Suspense>
		</ErrorBoundary>
	),
)

MarkdownRenderer.displayName = 'MarkdownRenderer'
