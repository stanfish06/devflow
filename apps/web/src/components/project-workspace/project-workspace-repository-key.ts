import type { ApiOutputs } from '@devflow/api-contract/contract-router'
import { workspaceMaterializationIdentityKey } from '@devflow/schemas/effect/project-workspace'

type WorkspaceStatus = ApiOutputs['projectWorkspaces']['getStatus']
type Repository = WorkspaceStatus['materializations'][number]['repositories'][number]

export const projectWorkspaceRepositoryKey = (repository: Repository) =>
	`${workspaceMaterializationIdentityKey(repository.status)}\0${repository.status.repositoryIdentity}`
