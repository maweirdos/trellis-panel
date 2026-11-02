import { z } from 'zod'
import type { ProjectSnapshot } from './types'
import type { ConversationResult } from './private-conversations'
import { requirementKnowledgeSelectionSchema, requirementKnowledgeSourceRefSchema } from './conversation-requirement-knowledge'
import type { RequirementKnowledgeConnection, RequirementKnowledgeConnectionChoice, RequirementKnowledgeCollection, RequirementKnowledgeSearchInput, RequirementKnowledgeSearchResult, RequirementKnowledgeSourceSnapshot as RequirementKnowledgeSnapshot } from './conversation-requirement-knowledge'
export type { RequirementKnowledgeSelection, RequirementKnowledgeSourceSnapshot as RequirementKnowledgeSnapshot } from './conversation-requirement-knowledge'

export const REQUIREMENT_BODY_BYTES = 256 * 1024
export const REQUIREMENT_FILE_BYTES = 16 * 1024 * 1024
export const REQUIREMENT_REFERENCES_BYTES = 32 * 1024 * 1024
export const REQUIREMENT_CANDIDATE_BYTES = 384 * 1024
export const REQUIREMENT_OPERATIONS_LIMIT = 128
const id = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const title = z.string().trim().min(1).max(200)
const body = z.string().max(200_000).refine(value => new TextEncoder().encode(value).byteLength <= REQUIREMENT_BODY_BYTES, '需求正文超过 256 KiB')
export const requirementFileSelectionSchema = z.object({ fileId: z.string().min(1).max(256), revision: digest }).strict()
const selections = z.array(requirementFileSelectionSchema).max(8).refine(values => new Set(values.map(value => value.fileId)).size === values.length, '同一文件不能重复引用')
export const requirementQuestionSchema = z.object({ id: z.string().min(1).max(100), question: z.string().trim().min(1).max(2000), answer: z.string().max(8000).optional(), required: z.boolean().optional() }).strict()
const questions = z.array(requirementQuestionSchema).max(32).refine(values => new Set(values.map(value => value.id)).size === values.length, '问题标识不能重复')
export const requirementConfirmedSchema = z.object({ revision: id, bodyRevision: digest, sourceDigest: digest, commandId: id, confirmedAt: z.number().int().nonnegative(), summary: z.string().max(2000), relativePath: z.string().min(1).max(8192), snapshotRevision: digest }).strict()
export const requirementPlanSchema = z.object({ body, revision: id, bodyRevision: digest, relativePath: z.string().min(1).max(8192), sourceRevision: id, sourceDigest: digest, stale: z.boolean(), updatedAt: z.number().int().nonnegative(), operationId: id.optional() }).strict()
export const requirementActionSchema = z.enum(['clarify', 'research', 'draft', 'revise', 'acceptance', 'plan', 'discuss'])
export const requirementDocumentSchema = z.enum(['requirement', 'plan'])
export const requirementCandidateSchema = z.object({ title, markdown: body, questions }).strict()
export const requirementOperationSchema = z.object({
  id, commandId: id, action: requirementActionSchema, document: requirementDocumentSchema,
  sourceRevision: id, sourceBodyRevision: digest, sourceDigest: digest, sourceFileRevision: digest, planSourceRevision: id.optional(), inputDigest: digest,
  displayText: z.string().min(1).max(16_000),
  knowledgeSelection: requirementKnowledgeSelectionSchema.optional(),
  knowledge: z.array(z.object({ sourceId: id, returnedRevision: digest, title: z.string().max(2000), connectionId: z.string().max(256), collectionId: z.string().max(256), documentId: z.string().max(500), contentHash: digest, truncated: z.boolean() }).strict()).max(8).default([]),
  sourcePath: z.string().min(1).max(8192), relativePath: z.string().min(1).max(8192),
  state: z.enum(['reserved', 'dispatching', 'running', 'candidate', 'adopted', 'failed', 'cancelled', 'unknown']),
  requestId: id, sessionId: z.string().min(1).max(256).optional(), connectionGeneration: z.string().min(1).max(256).optional(), turnId: z.string().min(1).max(256).optional(),
  candidateRevision: digest.optional(), candidateBodyRevision: digest.optional(), adoptedRevision: id.optional(),
  detail: z.string().max(2000).optional(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
}).strict()
export const requirementRunSchema = z.object({
  expectedRevision: id, commandId: id, action: requirementActionSchema, document: requirementDocumentSchema,
  text: z.string().max(16_000).optional(), quote: z.object({ text: z.string().min(1).max(16_000), bodyRevision: digest }).strict().optional(),
  fromConversation: z.boolean().optional(), knowledgeSelection: requirementKnowledgeSelectionSchema.optional(), knowledgeSources: z.array(requirementKnowledgeSourceRefSchema).max(8).optional()
}).strict()
export const requirementAdoptSchema = z.object({ expectedRevision: id, candidateRevision: digest }).strict()
export const requirementConfirmSchema = z.object({ expectedRevision: id, commandId: id }).strict()
export const requirementSavePlanSchema = z.object({ expectedRevision: id, expectedPlanRevision: id.nullable(), body, expectedFileRevision: digest.nullable().optional() }).strict()
export const requirementReferenceSchema = requirementFileSelectionSchema.extend({ name: z.string().min(1).max(500), relativePath: z.string().min(1).max(8192), snapshotPath: z.string().min(1).max(8192), bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) }).strict()
export const requirementTargetSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code') }).strict(),
  z.object({ kind: z.literal('directory'), grantId: id }).strict()
])
export const requirementTargetSchema = z.object({ id, root: z.string().min(1).max(8192), selectedAt: z.number().int().nonnegative() }).strict()
export const requirementTaskSchema = z.object({ root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200), taskId: z.string().min(1).max(200), title, status: z.string().min(1).max(100) }).strict()
export const requirementReceiptSchema = z.object({
  commandId: id, draftId: id, draftRevision: id, targetId: id, state: z.enum(['created', 'partial', 'uncertain']),
  task: requirementTaskSchema.optional(), files: z.array(z.string().min(1).max(8192)).max(20), detail: z.string().max(2000).optional(), planRevision: id.optional(), confirmedRevision: id.optional()
}).strict()
export const requirementDraftSchema = z.object({
  id, conversationId: id, creatorId: z.string().min(1).max(256), title, body, revision: id, bodyRevision: digest,
  relativePath: z.string().min(1).max(8192), references: z.array(requirementReferenceSchema).max(8),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), target: requirementTargetSchema.optional(), handoff: requirementReceiptSchema.optional(),
  questions: questions.default([]), confirmed: requirementConfirmedSchema.optional(), plan: requirementPlanSchema.optional(), operations: z.array(requirementOperationSchema).max(REQUIREMENT_OPERATIONS_LIMIT).default([])
}).strict()
export const requirementCreateSchema = z.object({ commandId: id, title: title.default('需求草稿'), body: body.default(''), references: selections.default([]) }).strict()
export const requirementSaveSchema = z.object({ expectedRevision: id, title, body, references: selections, questions: questions.optional(), expectedFileRevision: digest.nullable().optional() }).strict()
export const requirementSyncSchema = z.object({ expectedRevision: id, fileRevision: digest }).strict()
export const requirementTargetInputSchema = z.object({ expectedRevision: id, selection: requirementTargetSelectionSchema }).strict()
export const requirementCommitSchema = z.object({ expectedRevision: id, expectedPlanRevision: id, commandId: id, targetId: id }).strict()
export const requirementTaskOriginSchema = z.object({ version: z.literal(1), conversationId: id, creatorId: z.string().min(1).max(256), draftId: id, draftRevision: id, commandId: id, bodyRevision: digest, manifestRevision: digest, manifestPath: z.literal('references/conversation-requirement.json'), confirmedRevision: id.optional(), sourceDigest: digest.optional(), planRevision: id.optional(), planBodyRevision: digest.optional(), planSourceRevision: id.optional() }).strict()

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
export type RequirementTargetInput = z.infer<typeof requirementTargetInputSchema>
export type RequirementCommit = z.infer<typeof requirementCommitSchema>
export type RequirementQuestion = z.infer<typeof requirementQuestionSchema>
export type RequirementPlan = z.infer<typeof requirementPlanSchema>
export type RequirementConfirmed = z.infer<typeof requirementConfirmedSchema>
export type RequirementAction = z.infer<typeof requirementActionSchema>
export type RequirementDocument = z.infer<typeof requirementDocumentSchema>
export type RequirementCandidate = z.infer<typeof requirementCandidateSchema>
export type RequirementOperation = z.infer<typeof requirementOperationSchema>
export type RequirementRun = z.infer<typeof requirementRunSchema>
export type RequirementAdopt = z.infer<typeof requirementAdoptSchema>
export type RequirementConfirm = z.infer<typeof requirementConfirmSchema>
export type RequirementSavePlan = z.infer<typeof requirementSavePlanSchema>
export type RequirementTaskOrigin = z.infer<typeof requirementTaskOriginSchema>
export type RequirementSummary = Omit<RequirementDraft, 'body' | 'references' | 'plan' | 'operations'> & { referenceCount: number; hasPlan: boolean; planStale: boolean }
export interface RequirementView { draft: RequirementDraft; fileState: 'saved' | 'changed' | 'missing' | 'unavailable'; fileRevision?: string; detail?: string; planFileState?: 'saved' | 'changed' | 'missing' | 'unavailable'; planFileRevision?: string }
export interface RequirementObservation { operation: RequirementOperation; candidate?: RequirementCandidate }
export interface RequirementOpen { conversationId: string; draftId: string; task: RequirementTask; taskDir: string; snapshot: ProjectSnapshot }
export interface ConversationRequirementsApi {
  knowledge: {
    connections(conversationId: string): Promise<ConversationResult<RequirementKnowledgeConnectionChoice[]>>
    collections(conversationId: string, input: RequirementKnowledgeConnection): Promise<ConversationResult<{ items: RequirementKnowledgeCollection[]; hasMore: boolean }>>
    search(conversationId: string, input: RequirementKnowledgeSearchInput): Promise<ConversationResult<RequirementKnowledgeSearchResult>>
  }
  list(conversationId: string): Promise<ConversationResult<RequirementSummary[]>>
  create(conversationId: string, input: RequirementCreate): Promise<ConversationResult<RequirementView>>
  read(conversationId: string, draftId: string): Promise<ConversationResult<RequirementView>>
  save(conversationId: string, draftId: string, input: RequirementSave): Promise<ConversationResult<RequirementView>>
  sync(conversationId: string, draftId: string, input: RequirementSync): Promise<ConversationResult<RequirementView>>
  target(conversationId: string, draftId: string, input: RequirementTargetInput): Promise<ConversationResult<RequirementView>>
  run(conversationId: string, draftId: string, input: RequirementRun): Promise<ConversationResult<RequirementObservation>>
  observe(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementObservation>>
  evidence(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementKnowledgeSnapshot[]>>
  adopt(conversationId: string, draftId: string, operationId: string, input: RequirementAdopt): Promise<ConversationResult<RequirementView>>
  confirmRequirement(conversationId: string, draftId: string, input: RequirementConfirm): Promise<ConversationResult<RequirementView>>
  savePlan(conversationId: string, draftId: string, input: RequirementSavePlan): Promise<ConversationResult<RequirementView>>
  commit(conversationId: string, draftId: string, input: RequirementCommit): Promise<ConversationResult<RequirementReceipt>>
  open(conversationId: string, draftId: string): Promise<ConversationResult<RequirementOpen>>
  prepareExecution(conversationId: string, draftId: string, input: import('./conversation-requirement-execution').RequirementExecutionPrepare): Promise<ConversationResult<import('./conversation-requirement-execution').RequirementExecutionPreparation>>
}
