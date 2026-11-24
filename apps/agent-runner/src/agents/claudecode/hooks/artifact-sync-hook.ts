import { resolve } from 'node:path'

import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

import { extractArtifactSubpath, getArtifactSubpathPrefixes, isArtifactTrashPath } from '@/lib/artifact-subpath'
import { type ArtifactSyncLedger, createArtifactSyncLedger, recordSyncedFile } from '@/lib/artifact-sync-ledger'
import { buildDesignResolvedTemplateContext, isTextFile, syncFileAtPath } from '@/lib/artifact-sync-utils'
import { ARTIFACT_TRASH_SKIP_CONTEXT } from '@/lib/artifact-trash'
import type { ISyncManager } from '@/lib/sync-service'
import logger from '@/logger'

import type { HookServices } from '../types'
import { getFilePath, isArtifactPath } from '../whitelist'
import { artifactSyncedNote, getArtifactCloudUrl } from './artifact-url'

export interface ArtifactSyncHookDeps {
	getArtifactCloudUrl?: (artifactId: string) => string | undefined
	ledger?: ArtifactSyncLedger
	syncGitHubArtifactBacklink?: HookServices['orpc']['integrations']['github']['syncArtifactBacklink']
}

/**
 * Extracts tool name from HookInput if available.
 */
function getToolName(input: HookInput): string | undefined {
	return (input as { tool_name?: string }).tool_name
}

/**
 * Extracts content from Write tool input.
 */
function getWriteContent(toolInput: unknown): string | undefined {
	if (typeof toolInput === 'object' && toolInput !== null) {
		const input = toolInput as { content?: unknown }
		if (typeof input.content === 'string') {
			return input.content
		}
	}
	return undefined
}

/**
 * Creates a PostToolUse hook that syncs artifacts to the database when files in rpi/ are written.
 *
 * @param syncManager - The session-scoped sync manager for upserting artifacts
 * @param sessionId - The current session ID (for logging)
 * @param cwd - The working directory for path resolution
 * @param ticketProvider - The task's ticket provider; 'github' enables artifact backlink sync
 * @param services - Injectable services (oRPC client for integration calls)
 */
export function createArtifactSyncHook(
	syncManager: ISyncManager,
	sessionId: string,
	cwd: string,
	taskId: string,
	taskSlug: string | null,
	ticketProvider: string | null = null,
	services: HookServices | undefined,
	deps: ArtifactSyncHookDeps = {},
): HookCallback {
	const getArtifactCloudUrlFn = deps.getArtifactCloudUrl ?? getArtifactCloudUrl
	const ledger = deps.ledger ?? createArtifactSyncLedger()

	return async (
		input: HookInput,
		_toolUseID: string | undefined,
		options: { signal: AbortSignal },
	): Promise<HookJSONOutput> => {
		// Only handle PostToolUse events
		if (input.hook_event_name !== 'PostToolUse') {
			return { continue: true }
		}

		const toolName = getToolName(input)
		let filePath: string | undefined

		// Check abort signal
		if (options.signal.aborted) {
			return { continue: true }
		}

		try {
			// Extract file path from tool input
			filePath = getFilePath(input.tool_input)
			if (!filePath) {
				return { continue: true }
			}

			// Only sync files in rpi/ directory
			if (!isArtifactPath(filePath, cwd)) {
				return { continue: true }
			}

			logger.info({ sessionId, filePath, toolName }, 'Artifact sync hook triggered for rpi file')

			const resolvedFilePath = filePath.startsWith('/') ? filePath : resolve(cwd, filePath)
			const subpathPrefixes = getArtifactSubpathPrefixes(cwd, taskId, taskSlug)
			if (isArtifactTrashPath(resolvedFilePath, subpathPrefixes)) {
				logger.debug({ sessionId, filePath, taskId }, 'Artifact sync skipped for reserved trash path')
				return {
					continue: true,
					hookSpecificOutput: {
						hookEventName: 'PostToolUse',
						additionalContext: ARTIFACT_TRASH_SKIP_CONTEXT,
					},
				}
			}
			const subpath = extractArtifactSubpath(resolvedFilePath, subpathPrefixes)
			if (!subpath) {
				logger.debug(
					{ sessionId, filePath, taskId, taskSlug },
					'Artifact path did not resolve to a task subpath',
				)
				return { continue: true }
			}
			const fileName = subpath

			let operationType: 'Write' | 'Edit' | 'MultiEdit'
			if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
				operationType = toolName
			} else {
				logger.warn({ toolName, sessionId }, 'Unexpected tool name in artifact sync hook')
				operationType = 'Edit'
			}

			const writeContent = operationType === 'Write' ? getWriteContent(input.tool_input) : undefined
			if (operationType === 'Write' && isTextFile(fileName) && !writeContent) {
				logger.warn({ sessionId, filePath }, 'Write tool missing content in tool_input')
				return { continue: true }
			}

			const { artifactId, designQuestionsResolved, documentType } = await syncFileAtPath(
				resolvedFilePath,
				operationType,
				syncManager,
				sessionId,
				subpathPrefixes,
				writeContent,
				input.tool_input as Record<string, unknown>,
			)
			await recordSyncedFile(ledger, fileName, resolvedFilePath)
			const cloudUrl = getArtifactCloudUrlFn(artifactId)

			if (!isTextFile(fileName)) {
				if (ticketProvider === 'github') {
					try {
						const syncGitHubArtifactBacklink =
							deps.syncGitHubArtifactBacklink ?? services?.orpc.integrations.github.syncArtifactBacklink
						if (!syncGitHubArtifactBacklink) throw new Error('GitHub artifact backlink API is unavailable')
						await syncGitHubArtifactBacklink({ taskId })
					} catch (error) {
						logger.warn({ err: error, taskId }, 'Failed to synchronize GitHub artifact backlink')
					}
				}

				return {
					continue: true,
					hookSpecificOutput: {
						hookEventName: 'PostToolUse',
						additionalContext: `${artifactSyncedNote(cloudUrl)}`,
					},
				}
			}

			if (ticketProvider === 'github') {
				try {
					const syncGitHubArtifactBacklink =
						deps.syncGitHubArtifactBacklink ?? services?.orpc.integrations.github.syncArtifactBacklink
					if (!syncGitHubArtifactBacklink) throw new Error('GitHub artifact backlink API is unavailable')
					await syncGitHubArtifactBacklink({ taskId })
					logger.debug({ taskId }, 'GitHub artifact backlink synchronized via oRPC')
				} catch (error) {
					logger.warn({ err: error, taskId }, 'Failed to synchronize GitHub artifact backlink')
				}
			}

			return {
				continue: true,
				hookSpecificOutput: {
					hookEventName: 'PostToolUse',
					additionalContext: `${artifactSyncedNote(cloudUrl)}${buildDesignResolvedTemplateContext(designQuestionsResolved, documentType)}`,
				},
			}
		} catch (error) {
			if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				logger.debug({ filePath, sessionId }, 'Artifact file not found, skipping sync')
				return { continue: true }
			}
			// Non-blocking: log error but don't interrupt session
			logger.error({ err: error, sessionId, filePath, toolName }, 'Failed to sync artifact')
		}

		return { continue: true }
	}
}
