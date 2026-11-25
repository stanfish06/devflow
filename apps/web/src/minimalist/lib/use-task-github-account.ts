import type { Session } from '@devflow/db/tables/sessions'

import { useBrowserAuth } from '@/hooks/use-browser-auth'
import {
	type GithubAccountPick,
	pickOf,
	useGithubAccounts,
	useResolvedGithubAccount,
} from '@/minimalist/lib/github-accounts'
import { useUi } from '@/minimalist/lib/ui-state'
import { useAction } from '@/minimalist/lib/use-action'
import { useApi } from '@/orpc/client'

/**
 * The account your own sessions in this task push as, and a way to change it for the task. A
 * teammate's session follows their own choices, which aren't yours to show or change, and a
 * session outside a task has no task to pick for. Without any accounts there is nothing to show.
 */
export function useTaskGithubAccount(session: Session, projectId: string | null) {
	const { user } = useBrowserAuth()
	const { client: api } = useApi()
	const { showToast } = useUi()
	const action = useAction()
	const { projectDefaults } = useGithubAccounts()
	const resolved = useResolvedGithubAccount({ taskId: session.task_id, projectId })
	const mine = Boolean(user?.id) && session.created_by === user?.id && session.task_id !== null
	const shown = mine && resolved.isReady && (resolved.accounts.length > 0 || resolved.source === 'task')
	const pick = (next: GithubAccountPick) => {
		const taskId = session.task_id
		// Picking the account the task already inherits still pins it, so later default changes pass it by.
		if (!taskId || (resolved.source === 'task' && next === pickOf(resolved))) return
		const login = resolved.accounts.find((account) => account.id === next)?.login
		void action
			.run(
				() => api.tasks.setGithubAccount({ taskId, accountId: next }, { context: { silent: true } }),
				'Could not change the GitHub account. Try again.',
			)
			.then((saved) => {
				if (saved)
					showToast(
						login ? `This task now pushes as ${login}` : "This task now pushes as each host's own gh login",
					)
			})
	}
	return {
		shown,
		resolved,
		pending: action.pending,
		projectDefaultId: projectId ? projectDefaults[projectId] : undefined,
		pick,
	}
}
