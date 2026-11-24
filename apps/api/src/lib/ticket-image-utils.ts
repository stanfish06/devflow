/**
 * Utilities for extracting images from ticket content (GitHub issues).
 */

import { Option, Schema } from 'effect'

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'] as const
const ImageExtension = Schema.Literals(IMAGE_EXTENSIONS)
type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]
const IMAGE_EXTENSION_PATTERN = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})(\\?|$)`, 'i')

const CONTENT_TYPES: Record<ImageExtension, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
}

/**
 * Extract image URLs from markdown content.
 * Matches markdown image syntax: ![altText](url)
 * Only returns URLs that look like actual images (GitHub attachments or image extensions).
 */
export function extractImageUrls(markdown: string): Array<{ url: string; altText: string }> {
	const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
	const images: Array<{ url: string; altText: string }> = []

	for (const match of markdown.matchAll(imageRegex)) {
		const altText = match[1] || 'image'
		const url = match[2]
		if (!url) continue

		// Only include URLs that look like image URLs
		if (
			url.startsWith('http') &&
			(url.includes('github.com/user-attachments/assets/') || IMAGE_EXTENSION_PATTERN.test(url))
		) {
			images.push({ url, altText })
		}
	}

	return images
}

/**
 * Get file extension from URL or fall back to png.
 */
export function getFileExtension(url: string): string {
	try {
		const urlObj = new URL(url)
		const pathname = urlObj.pathname
		const match = pathname.match(/\.([a-zA-Z0-9]+)$/)
		if (match?.[1]) {
			return match[1].toLowerCase()
		}
	} catch {
		// Invalid URL, fall through to default
	}
	return 'png'
}

/**
 * Extract a reasonable filename from a URL.
 * Returns a sanitized filename without extension.
 */
export function extractFilenameFromUrl(url: string): string {
	try {
		const urlObj = new URL(url)
		const pathname = urlObj.pathname
		// Get last path segment
		const segments = pathname.split('/').filter(Boolean)
		const lastSegment = segments[segments.length - 1] || 'image'
		// Remove extension and sanitize
		const withoutExt = lastSegment.replace(/\.[a-zA-Z0-9]+$/, '')
		// Sanitize: replace non-alphanumeric with dashes, collapse multiple dashes
		const sanitized = withoutExt
			.replace(/[^a-zA-Z0-9-_]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
		return sanitized || 'image'
	} catch {
		return 'image'
	}
}

/**
 * Get the content type based on file extension.
 */
export function getContentType(extension: string): string {
	const parsedExtension = Option.getOrUndefined(Schema.decodeUnknownOption(ImageExtension)(extension.toLowerCase()))
	return parsedExtension ? CONTENT_TYPES[parsedExtension] : 'application/octet-stream'
}
