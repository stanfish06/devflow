import z from 'zod/v4'

/**
 * The Projects V2 experiment group first chosen for a member, stored as `v1`/`v2`.
 */
export const PROJECTS_V2_VARIANTS = ['v1', 'v2'] as const
export const ProjectsV2VariantSchema = z.enum(PROJECTS_V2_VARIANTS)
export type ProjectsV2Variant = z.infer<typeof ProjectsV2VariantSchema>
