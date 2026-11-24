import { posix } from 'node:path'

import { safeSubpathSchema } from '@devflow/api-contract/lib/filename-validation'

export function normalizeSubpath(rawPath: string): string {
	const validatedPath = safeSubpathSchema.parse(rawPath)
	return safeSubpathSchema.parse(posix.normalize(validatedPath))
}
