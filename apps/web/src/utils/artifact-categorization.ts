import { toCanonicalOperation } from '@devflow/ui/lib/tool-names'

export type ArtifactOperation = 'Read' | 'Edit' | 'Write' | 'MultiEdit'
export type ArtifactCategory = 'source' | 'edited' | 'new' | 'unreferenced'

function isArtifactOperation(operation: string | undefined): operation is ArtifactOperation {
	return operation === 'Read' || operation === 'Write' || operation === 'Edit' || operation === 'MultiEdit'
}

/**
 * Categorize an artifact based on its operation sequence.
 *
 * Rules:
 * - Source: Read before Write/Edit, OR Read-only (can overlap with Edited)
 * - Edited: Edit/MultiEdit called, OR Write after Read (can overlap with Source)
 * - New: Write before any Read (file created) - exclusive, no overlap
 */
export function categorizeArtifact(operations: string[]): ArtifactCategory[] {
	const canonicalOperations = operations
		.map((operation) => toCanonicalOperation(operation) ?? operation)
		.filter(isArtifactOperation)

	if (canonicalOperations.length === 0) return []

	const firstOp = canonicalOperations[0]
	const hasRead = canonicalOperations.includes('Read')
	const hasWrite = canonicalOperations.includes('Write')
	const hasEdit = canonicalOperations.includes('Edit') || canonicalOperations.includes('MultiEdit')

	// Write first = New (exclusive)
	if (firstOp === 'Write') {
		return ['new']
	}

	const categories: ArtifactCategory[] = []

	// Read first or Read-only = Source
	if (firstOp === 'Read' || (hasRead && !hasWrite && !hasEdit)) {
		categories.push('source')
	}

	// Any Edit/MultiEdit, or Write after Read = Edited
	if (hasEdit || (hasWrite && hasRead)) {
		categories.push('edited')
	}

	// Read-only case (no edit, no write)
	if (hasRead && !hasWrite && !hasEdit && !categories.includes('source')) {
		categories.push('source')
	}

	return categories
}

/**
 * Check if a file path should be tracked as an artifact.
 * Only tracks files in .devflow/tasks/ or thoughts/ directories.
 * Handles both relative paths (.devflow/tasks/...) and absolute paths (/Users/.../.devflow/tasks/...)
 */
export function isArtifactPath(filePath: string): boolean {
	const normalized = filePath.replace(/^\.\//, '')
	return (
		normalized.startsWith('.devflow/tasks/') ||
		normalized.startsWith('thoughts/') ||
		normalized.includes('/.devflow/tasks/') ||
		normalized.includes('/thoughts/')
	)
}

/**
 * Extract the artifact-relative path from a full path.
 * e.g., "/Users/foo/project/.devflow/tasks/file.md" -> ".devflow/tasks/file.md"
 */
export function extractArtifactPath(filePath: string): string | null {
	const normalized = filePath.replace(/^\.\//, '')

	// Already relative
	if (normalized.startsWith('.devflow/tasks/') || normalized.startsWith('thoughts/')) {
		return normalized
	}

	// Extract from absolute path
	const hlMatch = normalized.match(/\/.devflow\/tasks\/(.*)$/)
	if (hlMatch) {
		return `.devflow/tasks/${hlMatch[1]}`
	}

	const thoughtsMatch = normalized.match(/\/thoughts\/(.*)$/)
	if (thoughtsMatch) {
		return `thoughts/${thoughtsMatch[1]}`
	}

	return null
}
