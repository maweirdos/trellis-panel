import { z } from 'zod'
import type { ProjectSnapshot } from './types'
import type { ConversationResult } from './private-conversations'

export const REQUIREMENT_BODY_BYTES = 256 * 1024
export const REQUIREMENT_FILE_BYTES = 16 * 1024 * 1024
export const REQUIREMENT_REFERENCES_BYTES = 32 * 1024 * 1024
const id = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const title = z.string().trim().min(1).max(200)
const body = z.string().max(200_000).refine(value => new TextEncoder().encode(value).byteLength <= REQUIREMENT_BODY_BYTES, '需求正文超过 256 KiB')
export const requirementFileSelectionSchema = z.object({ fileId: z.string().min(1).max(256), revision: digest }).strict()
const selections = z.array(requirementFileSelectionSchema).max(8).refine(values => new Set(values.map(value => value.fileId)).size === values.length, '同一文件不能重复引用')
export const requirementReferenceSchema = requirementFileSelectionSchema.extend({ name: z.string().min(1).max(500), relativePath: z.string().min(1).max(8192), snapshotPath: z.string().min(1).max(8192), bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) }).strict()
export const requirementTargetSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code') }).strict(),
  z.object({ kind: z.literal('directory'), grantId: id }).strict()
])
export const requirementTargetSchema = z.object({ id, root: z.string().min(1).max(8192), selectedAt: z.number().int().nonnegative() }).strict()
export const requirementTaskSchema = z.object({ root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200), taskId: z.string().min(1).max(200), title, status: z.string().min(1).max(100) }).strict()
export const requirementReceiptSchema = z.object({
  commandId: id, draftId: id, draftRevision: id, targetId: id, state: z.enum(['created', 'partial', 'uncertain']),
  task: requirementTaskSchema.optional(), files: z.array(z.string().min(1).max(8192)).max(20), detail: z.string().max(2000).optional()
}).strict()
export const requirementDraftSchema = z.object({
  id, conversationId: id, creatorId: z.string().min(1).max(256), title, body, revision: id, bodyRevision: digest,
  relativePath: z.string().min(1).max(8192), references: z.array(requirementReferenceSchema).max(8),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), target: requirementTargetSchema.optional(), handoff: requirementReceiptSchema.optional()
}).strict()
export const requirementCreateSchema = z.object({ commandId: id, title: title.default('需求草稿'), body: body.default(''), references: selections.default([]) }).strict()
export const requirementSaveSchema = z.object({ expectedRevision: id, title, body, references: selections, expectedFileRevision: digest.nullable().optional() }).strict()
export const requirementSyncSchema = z.object({ expectedRevision: id, fileRevision: digest }).strict()
export const requirementPromptSchema = z.object({ expectedRevision: id }).strict()
export const requirementTargetInputSchema = z.object({ expectedRevision: id, selection: requirementTargetSelectionSchema }).strict()
export const requirementCommitSchema = z.object({ expectedRevision: id, commandId: id, targetId: id }).strict()
export const requirementTaskOriginSchema = z.object({ version: z.literal(1), conversationId: id, creatorId: z.string().min(1).max(256), draftId: id, draftRevision: id, commandId: id, bodyRevision: digest, manifestRevision: digest, manifestPath: z.literal('references/conversation-requirement.json') }).strict()

export type RequirementFileSelection = z.infer<typeof requirementFileSelectionSchema>
export type RequirementReference = z.infer<typeof requirementReferenceSchema>
export type RequirementTargetSelection = z.infer<typeof requirementTargetSelectionSchema>
export type RequirementTarget = z.infer<typeof requirementTargetSchema>
export type RequirementTask = z.infer<typeof requirementTaskSchema>
export type RequirementReceipt = z.infer<typeof requirementReceiptSchema>
export type RequirementDraft = z.infer<typeof requirementDraftSchema>
export type RequirementCreate = z.input<typeof requirementCreateSchema>
export type RequirementSave = z.infer<typeof requirementSaveSchema>
export type RequirementSync = z.infer<typeof requirementSyncSchema>
export type RequirementPromptInput = z.infer<typeof requirementPromptSchema>
export type RequirementTargetInput = z.infer<typeof requirementTargetInputSchema>
export type RequirementCommit = z.infer<typeof requirementCommitSchema>
export type RequirementTaskOrigin = z.infer<typeof requirementTaskOriginSchema>
export type RequirementSummary = Omit<RequirementDraft, 'body' | 'references'> & { referenceCount: number }
export interface RequirementView { draft: RequirementDraft; fileState: 'saved' | 'changed' | 'missing' | 'unavailable'; fileRevision?: string; detail?: string }
export interface RequirementPrompt { draftId: string; revision: string; relativePath: string; bodyRevision: string; text: string }
export interface RequirementOpen { conversationId: string; draftId: string; task: RequirementTask; taskDir: string; snapshot: ProjectSnapshot }
export interface ConversationRequirementsApi {
  list(conversationId: string): Promise<ConversationResult<RequirementSummary[]>>
  create(conversationId: string, input: RequirementCreate): Promise<ConversationResult<RequirementView>>
  read(conversationId: string, draftId: string): Promise<ConversationResult<RequirementView>>
  save(conversationId: string, draftId: string, input: RequirementSave): Promise<ConversationResult<RequirementView>>
  sync(conversationId: string, draftId: string, input: RequirementSync): Promise<ConversationResult<RequirementView>>
  prompt(conversationId: string, draftId: string, input: RequirementPromptInput): Promise<ConversationResult<RequirementPrompt>>
  target(conversationId: string, draftId: string, input: RequirementTargetInput): Promise<ConversationResult<RequirementView>>
  commit(conversationId: string, draftId: string, input: RequirementCommit): Promise<ConversationResult<RequirementReceipt>>
  open(conversationId: string, draftId: string): Promise<ConversationResult<RequirementOpen>>
}
