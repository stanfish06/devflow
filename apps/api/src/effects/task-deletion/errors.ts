import { Data } from 'effect'

/** The task doesn't exist in the caller's organization. */
export class TaskNotFound extends Data.TaggedError('TaskNotFound')<{
	readonly taskId: string
}> {}

/** Only a task's owner may delete it; organization admins get no override. */
export class NotTaskOwner extends Data.TaggedError('NotTaskOwner')<{
	readonly taskId: string
	readonly userId: string
}> {}

/**
 * A multi-task delete found a different number of tasks under the lock than the caller confirmed,
 * so it refuses rather than deleting work the confirmation never counted.
 */
export class CountChanged extends Data.TaggedError('CountChanged')<{
	readonly expected: number
	readonly actual: number
}> {}
