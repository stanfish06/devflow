export const slugInTaskUsedMessage = (slug: string): string =>
	`The name "${slug}" is already in use. The task that uses it may be archived. Choose a different name.`

export const TASK_ID_IN_USE_MESSAGE = 'This draft was already launched. Refresh and try again.'

/** A launch picked a GitHub account that isn't the caller's, usually one removed since the composer loaded. */
export const GITHUB_ACCOUNT_NOT_FOUND = 'The GitHub account picked for this task was not found. Pick another one.'
