import { ConsoleTransport, Logger } from '@devflow/logger/browser'

export const logger = new Logger({
	transports: [new ConsoleTransport('debug')],
	properties: {},
})
