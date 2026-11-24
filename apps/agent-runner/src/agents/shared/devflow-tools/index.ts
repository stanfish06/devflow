/**
 * devflow tools for the Claude Code MCP server.
 *
 * Architecture:
 * - schemas.ts: Shared Zod schemas for inputs
 * - executors.ts: Shared execution logic and formatters
 * - mcp-tools.ts: MCP server tool factories using Claude SDK tool()
 */

// Executors
export {
	buildCommentsOutput,
	type CommentItem,
	type ExecutorResult,
	executeGetArtifactComments,
	executeGetDiffComments,
	executeLibraryResearcher,
	executeReplyToArtifactComment,
	executeReplyToDiffComment,
	executeUpdateArtifactComments,
	executeUpdateDiffComments,
	formatDiffCommentsPage,
	formatDiffCommentToolError,
	formatErrorWithArtifacts,
	type RunDiffCommentToolEffect,
} from './executors'
// Schemas
export {
	type GetArtifactCommentsInput,
	GetArtifactCommentsInputSchema,
	type GetDiffCommentsInput,
	GetDiffCommentsInputSchema,
	type LibraryResearcherInput,
	LibraryResearcherInputSchema,
	type ReplyToArtifactCommentInput,
	ReplyToArtifactCommentInputSchema,
	type ReplyToDiffCommentInput,
	ReplyToDiffCommentInputSchema,
	TOOL_DESCRIPTIONS,
	type UpdateArtifactCommentsInput,
	UpdateArtifactCommentsInputSchema,
	type UpdateDiffCommentsInput,
	UpdateDiffCommentsInputSchema,
} from './schemas'
