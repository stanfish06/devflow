import { generateTaskSummary } from '@devflow/ai/generate-task-summary'

import { createAppReliableLanguageModel } from '../../../lib/reliable-language-model'
import { logger } from '../../../logger'
import { apiBaseOrgRequired } from '../../base'

export const generateTitleProcedure = apiBaseOrgRequired.ai.generateTitle.handler(async ({ input, errors }) => {
	try {
		const title = await generateTaskSummary(input.text, { model: createAppReliableLanguageModel('haiku') })
		return { title }
	} catch (error) {
		logger.error(error)
		throw errors.INTERNAL_SERVER_ERROR()
	}
})
