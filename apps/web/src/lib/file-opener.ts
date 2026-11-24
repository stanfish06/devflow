import { toast } from 'sonner'

import { logger } from '@/lib/logger'

interface OpenFileOptions {
	filePath: string
	workingDir?: string
}

/** Check if a path is absolute (starts with / on Unix or a drive letter on Windows). */
function isAbsolutePath(filePath: string): boolean {
	return filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)
}

/** Join path segments, handling both Unix and Windows separators. */
function joinPath(base: string, relative: string): string {
	const separator = base.includes('\\') ? '\\' : '/'
	const cleanBase = base.endsWith(separator) ? base.slice(0, -1) : base
	const cleanRelative = relative.startsWith(separator) ? relative.slice(1) : relative
	return `${cleanBase}${separator}${cleanRelative}`
}

/** The file's path on the host: relative paths join the working directory. */
function resolveFilePath({ filePath, workingDir }: OpenFileOptions): string {
	if (isAbsolutePath(filePath) || !workingDir) return filePath
	return joinPath(workingDir, filePath)
}

/** Copies the file's path on the host to the clipboard. */
export async function copyFilePath(options: OpenFileOptions): Promise<void> {
	const fullPath = resolveFilePath(options)
	try {
		await navigator.clipboard.writeText(fullPath)
		toast.success('Copied file path', { description: fullPath })
	} catch (error) {
		logger.error('Failed to copy file path to clipboard:', error)
		toast.error('Could not copy file path', { description: 'Clipboard access was denied. Try again.' })
	}
}

/** A browser can't open files on the host, so this copies the path for pasting into an editor. */
export async function openFileInEditor(options: OpenFileOptions): Promise<void> {
	const fullPath = resolveFilePath(options)
	try {
		await navigator.clipboard.writeText(fullPath)
		toast.info(`Copied path to clipboard: ${fullPath}`)
	} catch (error) {
		logger.error('Failed to copy path to clipboard:', error)
		toast.error('Failed to copy path to clipboard')
	}
}
