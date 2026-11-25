import { ProjectSandboxSchema } from '@devflow/schemas/zod/host/agent-sandbox'
import { ProjectRepositoriesSchema, ProjectRepositoryPathsSchema } from '@devflow/schemas/zod/project-workspace'
import z from 'zod/v4'

export const projectV2Schema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	name: z.string(),
	description: z.string().nullable(),
	private: z.boolean(),
	createdBy: z.string(),
	resourceOwnerUserId: z.string(),
	repositories: ProjectRepositoriesSchema,
	archived: z.boolean(),
	/** Where the project's agents run; new tasks copy it at launch. */
	sandbox: ProjectSandboxSchema,
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	/**
	 * The caller's own hosts with an existing checkout of any of the project's repositories. Empty
	 * when the caller only clones on demand, so the project can run on any host.
	 */
	checkoutHostIds: z.array(z.string()),
})

export const projectLocationV2Schema = z.object({
	projectId: z.uuid(),
	organizationId: z.uuid(),
	userId: z.string(),
	hostId: z.string(),
	repositoryPaths: ProjectRepositoryPathsSchema,
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
})

export const projectMutationFieldsSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().trim().min(1).nullable().optional(),
	private: z.boolean(),
	repositories: ProjectRepositoriesSchema,
	/** Absent on create: `default`. */
	sandbox: ProjectSandboxSchema.optional(),
})

export type ProjectV2 = z.infer<typeof projectV2Schema>
export type ProjectLocationV2 = z.infer<typeof projectLocationV2Schema>
export type ProjectMutationFields = z.infer<typeof projectMutationFieldsSchema>
