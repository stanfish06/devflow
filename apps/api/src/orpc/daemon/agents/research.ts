import { researchDocumentation } from '@devflow/ai/doc-researcher'

import { createAppReliableLanguageModel } from '../../../lib/reliable-language-model'
import logger from '../../../logger'
import { daemonBase } from '../../base'

export const researchProcedure = daemonBase.agents.research.handler(async ({ input, context, errors }) => {
	const { question, packageName, language } = input
	const { userId, organizationId } = context.auth

	try {
		logger.info({ packageName, question, userId, organizationId }, 'Starting documentation research')

		const result = await researchDocumentation(
			{ question, packageName, language },
			{ model: createAppReliableLanguageModel('sonnet') },
		)

		logger.info({ packageName, resultType: result.type }, 'Documentation research completed')

		return {
			success: result.type === 'answer',
			response: result.type === 'answer' ? result.content : result.message,
		}
	} catch (error) {
		logger.error({ error, packageName }, 'Documentation research failed')
		throw errors.INTERNAL_SERVER_ERROR()
	}
})
