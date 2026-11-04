import { z } from 'zod'

const revision = z.string().regex(/^[a-f0-9]{64}$/)
const name = z.string().min(1).max(500)

// File references are existing requirement attachments; design references name
// an exact design-workspace revision. Neither is an authorization or snapshot.
export const requirementDesignFileSchema = z.object({
  kind: z.literal('file'), fileId: z.string().min(1).max(256), revision, name
}).strict()
export const requirementDesignProjectFileSchema = z.object({
  kind: z.literal('project-file'), projectRoot: z.string().min(1).max(8192), relativePath: z.string().min(1).max(8192), revision, name
}).strict()
export const requirementDesignDocumentSchema = z.object({
  kind: z.literal('design'), documentId: z.string().uuid(), revision, name
}).strict()
export const requirementDesignStandardSchema = z.discriminatedUnion('kind', [requirementDesignFileSchema, requirementDesignProjectFileSchema])
export const requirementDesignMaterialSchema = z.discriminatedUnion('kind', [requirementDesignFileSchema, requirementDesignProjectFileSchema, requirementDesignDocumentSchema])
export const requirementDesignContextSchema = z.object({
  standards: z.array(requirementDesignStandardSchema).max(8),
  materials: z.array(requirementDesignMaterialSchema).max(8),
  direction: z.string().max(4000)
}).strict().superRefine((value, context) => {
  if (new Set(value.standards.map(requirementDesignSourceKey)).size !== value.standards.length) context.addIssue({ code: 'custom', path: ['standards'], message: '设计规范不能重复' })
  if (new Set(value.materials.map(requirementDesignSourceKey)).size !== value.materials.length) context.addIssue({ code: 'custom', path: ['materials'], message: '设计素材不能重复' })
})

export type RequirementDesignFile = z.infer<typeof requirementDesignFileSchema>
export type RequirementDesignStandard = z.infer<typeof requirementDesignStandardSchema>
export type RequirementDesignMaterial = z.infer<typeof requirementDesignMaterialSchema>
export type RequirementDesignContext = z.infer<typeof requirementDesignContextSchema>
export function requirementDesignSourceKey(item: RequirementDesignMaterial): string {
  if (item.kind === 'file') return JSON.stringify([item.kind, item.fileId])
  if (item.kind === 'project-file') return JSON.stringify([item.kind, item.projectRoot, item.relativePath])
  return JSON.stringify([item.kind, item.documentId])
}
export const emptyRequirementDesignContext = (): RequirementDesignContext => ({ standards: [], materials: [], direction: '' })
