import { classifyTaskIntent } from '@devflow/ai/classify-task-intent'
import type { TaskIntent } from '@devflow/schemas/task-intent'
import { Context, Effect, Layer } from 'effect'

import { createAppReliableLanguageModel } from '../../../lib/reliable-language-model'

export interface TaskIntentClassifierShape {
	readonly classify: (text: string) => Effect.Effect<TaskIntent>
}

export class TaskIntentClassifier extends Context.Service<TaskIntentClassifier, TaskIntentClassifierShape>()(
	'TaskIntentClassifier',
) {}

export function makeTaskIntentClassifier(classify: (text: string) => Promise<TaskIntent>): TaskIntentClassifierShape {
	return {
		classify: (text) =>
			Effect.tryPromise(() => classify(text)).pipe(
				Effect.catch((error) =>
					Effect.logWarning('Task intent classification failed; using implementation label', error).pipe(
						Effect.as<TaskIntent>('implementation'),
					),
				),
			),
	}
}

export const TaskIntentClassifierLive = Layer.succeed(
	TaskIntentClassifier,
	makeTaskIntentClassifier((text) =>
		classifyTaskIntent(text, {
			model: createAppReliableLanguageModel('haiku'),
		}),
	),
)
