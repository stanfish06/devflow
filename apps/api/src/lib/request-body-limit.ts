import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { MAX_TEXT_CONTENT_BYTES } from './constants'

export const requestBodyLimit: MiddlewareHandler = bodyLimit({
	maxSize: MAX_TEXT_CONTENT_BYTES,
	onError: (c) => c.json({ error: 'Request body too large', maxSize: '10MB' }, 413),
})
