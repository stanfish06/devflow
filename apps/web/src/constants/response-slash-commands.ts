import type { SlashCommand } from '@devflow/ui/components/rich-text-editor'
import { DEVFLOW_SLASH_COMMANDS } from '@devflow/ui/constants/devflow-skills'
import { RPI_SLASH_COMMANDS } from '@devflow/ui/constants/rpi-skills'
import { COMPACT_COMMAND, SYSTEM_SLASH_COMMANDS } from '@devflow/ui/constants/system-slash-commands'

export const SIMPLE_RESPONSE_RESTATE_COMMAND = '/bro'
export const SIMPLE_RESPONSE_RESTATE_PROMPT =
	'Restate your last message. Stop using jargon and speak coherently. State it more simply and concisely, like one human talking to another.'
export const COMPACT_RESPONSE_COMMAND = COMPACT_COMMAND

export const RESPONSE_SLASH_COMMANDS: SlashCommand[] = [
	{ name: SIMPLE_RESPONSE_RESTATE_COMMAND, source: 'bundled' },
	...SYSTEM_SLASH_COMMANDS,
	...DEVFLOW_SLASH_COMMANDS,
	...RPI_SLASH_COMMANDS,
]
