import { artifactName, isAttachment, isPromptArtifact } from '@/minimalist/lib/artifacts'
import { useTaskArtifacts } from '@/minimalist/lib/data'

/** Where `@` looks: the task's documents. */
export type MentionScope = { taskId: string | null }

export type Mention = { key: string; label: string; detail: string; insert: string }

/** The `@word` being typed at the caret, or null. An @ inside a word (an email) is not a mention. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
	const query = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))?.[1]
	return query === undefined ? null : { start: caret - query.length - 1, query }
}

/** Replaces the `@word` with the chosen mention and a space, returning where the caret goes. */
export function insertMention(
	value: string,
	at: { start: number; query: string },
	text: string,
): { value: string; caret: number } {
	const rest = value.slice(at.start + 1 + at.query.length)
	return { value: `${value.slice(0, at.start)}${text} ${rest.replace(/^ /, '')}`, caret: at.start + text.length + 1 }
}

const MAX = 10

/** What `@query` offers: the task documents whose names match. Empty while no mention is being typed. */
export function useMentions(query: string | null, scope: MentionScope | undefined): Mention[] {
	const artifacts = useTaskArtifacts(scope?.taskId ?? null)
	if (query === null) return []
	const needle = query.toLowerCase()
	return artifacts
		.filter((artifact) => artifact.task_slug && !isPromptArtifact(artifact) && !isAttachment(artifact))
		.filter((artifact) => artifactName(artifact.file_name).toLowerCase().includes(needle))
		.slice(0, MAX)
		.map((artifact) => ({
			key: artifact.id,
			label: artifactName(artifact.file_name),
			detail: 'Task document',
			insert: `@.devflow/tasks/${artifact.task_slug}/${artifact.file_name}`,
		}))
}
