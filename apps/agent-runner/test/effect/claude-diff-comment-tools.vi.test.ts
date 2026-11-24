import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { createClaudeDiffCommentTools, createMcpServer, type McpToolsApi } from '@/agents/claudecode/mcp/devflow-server'
import { TOOL_DESCRIPTIONS } from '@/agents/shared/devflow-tools/schemas'

import { makeMockDaemonApiLayer } from '../mocks/daemon-api.mock'

function makeApi(): McpToolsApi {
	const unusedPromise = async () => {
		throw new Error('unused MCP API method')
	}
	const layer = makeMockDaemonApiLayer({ getDiffComments: () => Effect.succeed({ comments: [] }) })
	return {
		comments: { get: unusedPromise, update: unusedPromise, reply: unusedPromise },
		agents: { research: unusedPromise },
		runDiffCommentEffect: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
	}
}

describe('Claude diff comment tools', () => {
	test('registers all three exact tools for a task-bound session', async () => {
		const tools = createClaudeDiffCommentTools(makeApi(), 'task-from-server')
		expect(tools.map((tool) => tool.name)).toEqual([
			'get_diff_comments',
			'reply_to_diff_comment',
			'update_diff_comments',
		])
		expect(tools.find((tool) => tool.name === 'update_diff_comments')?.description).toBe(
			TOOL_DESCRIPTIONS.update_diff_comments,
		)
		const getResult = await tools[0]?.handler({ include_resolved: false, offset: 0, limit: 20 }, {})
		expect(getResult).toEqual({ content: [{ type: 'text', text: 'No diff comments found for this task' }] })
	})

	test('does not create task tools for a taskless session', () => {
		expect(createMcpServer(makeApi(), { taskId: null, enableLibraryResearcher: false })).toBeNull()
	})
})
