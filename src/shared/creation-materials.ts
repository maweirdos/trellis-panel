import { z } from 'zod'
import { creationAdoptionSchema } from './creations'

export const creationMaterialReferenceSchema = creationAdoptionSchema.extend({ creationId: z.string().uuid(), kind: z.enum(['prototype', 'document']) }).strict()
export type CreationMaterialReference = z.infer<typeof creationMaterialReferenceSchema>
export type CreationMaterialFile = { relativePath: string; body: string; bodyDigest: string }
export function creationReferencePath(reference: CreationMaterialReference): string {
  return `references/${reference.creationId}/${reference.revisionId}.${reference.kind === 'prototype' ? 'html' : 'md'}`
}
