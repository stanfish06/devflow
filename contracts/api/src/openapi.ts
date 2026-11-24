import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'

import { ApiContract } from './contract-router'

const openAPIGenerator = new OpenAPIGenerator({
	schemaConverters: [new ZodToJsonSchemaConverter()],
})

export const openApiSpecFromRouter = await openAPIGenerator.generate(ApiContract, {
	info: {
		title: 'devflow API',
		version: '0.0.0',
	},
})
