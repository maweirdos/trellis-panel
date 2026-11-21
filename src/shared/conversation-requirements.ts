import { z } from 'zod'
import type { ProjectSnapshot } from './types'
import type { ConversationResult } from './private-conversations'
import type { IpcFail } from './ipc-errors'
import { requirementKnowledgeSelectionSchema, requirementKnowledgeSourceRefSchema } from './conversation-requirement-knowledge'
import { requirementDesignContextSchema, requirementDesignStandardSchema, requirementDesignSourceKey } from './requirement-design-context'
import type { RequirementKnowledgeConnection, RequirementKnowledgeConnectionChoice, RequirementKnowledgeCollection, RequirementKnowledgeSearchInput, RequirementKnowledgeSearchResult, RequirementKnowledgeSourceSnapshot as RequirementKnowledgeSnapshot } from './conversation-requirement-knowledge'
export type { RequirementKnowledgeSelection, RequirementKnowledgeSourceSnapshot as RequirementKnowledgeSnapshot } from './conversation-requirement-knowledge'

export const REQUIREMENT_BODY_BYTES = 256 * 1024
export const REQUIREMENT_FILE_BYTES = 16 * 1024 * 1024
export const REQUIREMENT_REFERENCES_BYTES = 32 * 1024 * 1024
export const REQUIREMENT_CANDIDATE_BYTES = 384 * 1024
export const REQUIREMENT_OPERATIONS_LIMIT = 128
export const REQUIREMENT_TEMPLATE = '# 需求名称\n\n## 背景\n\n## 目标\n\n## 范围\n\n## 具体需求\n\n## 验收标准\n\n## 待确认问题\n'
/** Template headings and empty placeholders do not constitute business requirements. */
export function hasRequirementContent(value: string): boolean {
  return value.split(/\r?\n/).some(line => {
    const text = line.replace(/^\s*(?:#{1,6}\s*|[-*+]\s*|\d+[.)]\s*)?/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    return Boolean(text && !/^(?:(?:需求名称|背景|目标|范围|具体需求|验收标准|待确认问题)(?:\s*[：:]\s*(?:待确认|待补充|暂无)?)?|待确认|待补充|暂无|[：:…\.\-—_\[\]()（）\s]+)$/u.test(text))
  })
}
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
export const requirementCandidateSchema = z.object({ title, markdown: body, questions, selectionReplacement: body.optional() }).strict()
export const requirementQuoteSchema = z.object({ text: z.string().min(1).max(16_000), bodyRevision: digest, anchor: z.object({ kind: z.enum(['markdown', 'prosemirror']), from: z.number().int().nonnegative().max(200_000), to: z.number().int().positive().max(200_000) }).strict().optional(), comparisonOnly: z.boolean().optional() }).strict()
export const requirementSelectionReceiptSchema = z.object({ operationId: id, expectedRevision: id, candidateRevision: digest, inputDigest: digest, adoptedRevision: id, bodyRevision: digest }).strict()
export const requirementOperationSchema = z.object({
  id, commandId: id, action: requirementActionSchema, document: requirementDocumentSchema,
  sourceRevision: id, sourceBodyRevision: digest, sourceDigest: digest, sourceFileRevision: digest, planSourceRevision: id.optional(), inputDigest: digest,
  displayText: z.string().min(1).max(16_000),
  knowledgeSelection: requirementKnowledgeSelectionSchema.optional(),
  knowledge: z.array(z.object({ sourceId: id, returnedRevision: digest, title: z.string().max(2000), connectionId: z.string().max(256), collectionId: z.string().max(256), documentId: z.string().max(500), contentHash: digest, truncated: z.boolean() }).strict()).max(8).default([]),
  sourcePath: z.string().min(1).max(8192), relativePath: z.string().min(1).max(8192),
  state: z.enum(['reserved', 'dispatching', 'running', 'completed', 'candidate', 'adopted', 'failed', 'cancelled', 'unknown']),
  requestId: id, sessionId: z.string().min(1).max(256).optional(), connectionGeneration: z.string().min(1).max(256).optional(), turnId: z.string().min(1).max(256).optional(),
  candidateRevision: digest.optional(), candidateBodyRevision: digest.optional(), adoptedRevision: id.optional(),
  selectionReceipt: requirementSelectionReceiptSchema.optional(),
  quote: requirementQuoteSchema.optional(),
  detail: z.string().max(2000).optional(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
}).strict()
export const requirementRunSchema = z.object({
  expectedRevision: id, commandId: id, action: requirementActionSchema, document: requirementDocumentSchema,
  text: z.string().max(16_000).optional(), quote: requirementQuoteSchema.optional(),
  fromConversation: z.boolean().optional(), knowledgeSelection: requirementKnowledgeSelectionSchema.optional(), knowledgeSources: z.array(requirementKnowledgeSourceRefSchema).max(8).optional()
}).strict()
export const requirementAdoptSchema = z.object({ expectedRevision: id, candidateRevision: digest }).strict()
export const requirementApplySelectionSchema = z.object({ expectedRevision: id, candidateRevision: digest, body, expectedPlanRevision: id.optional() }).strict()
export const requirementHandoffSourceSchema = requirementKnowledgeSourceRefSchema.extend({ operationId: id }).strict()
export const requirementDirectKnowledgeSchema = z.object({ version: z.literal(1), selection: requirementKnowledgeSelectionSchema, sources: z.array(requirementKnowledgeSourceRefSchema).min(1).max(8).refine(values => new Set(values.map(value => value.sourceId)).size === values.length, '直接交接摘录不能重复') }).strict()
export const requirementKnowledgeGrantSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), sources: z.array(requirementHandoffSourceSchema).max(128) }).strict(),
  z.object({ version: z.literal(2), sources: z.array(requirementHandoffSourceSchema).max(128), direct: requirementDirectKnowledgeSchema.optional() }).strict()
])
export const requirementConfirmSchema = z.object({ expectedRevision: id, commandId: id }).strict()
export const requirementSavePlanSchema = z.object({ expectedRevision: id, expectedPlanRevision: id.nullable(), body, expectedFileRevision: digest.nullable().optional(), resolvePending: z.literal(true).optional() }).strict()
export const requirementReferenceSchema = requirementFileSelectionSchema.extend({ name: z.string().min(1).max(500), relativePath: z.string().min(1).max(8192), snapshotPath: z.string().min(1).max(8192), bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) }).strict()
export const requirementDesignSnapshotSchema = z.object({ source: requirementDesignStandardSchema, relativePath: z.string().min(1).max(8192), snapshotPath: z.string().min(1).max(8192), bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES) }).strict()
const designHandoffSources = z.array(requirementDesignStandardSchema).max(16).refine(values => new Set(values.map(requirementDesignSourceKey)).size === values.length, '设计交接文件不能重复')
export const requirementDesignGrantSchema = z.object({ version: z.literal(1), sources: designHandoffSources }).strict()
export const requirementDesignEvidenceSchema = z.object({ source: requirementDesignStandardSchema, originalPath: z.string().min(1).max(8192), path: z.string().regex(/^references\/requirement-design\/(?:[0-9]|1[0-5])\.[a-z0-9]{1,10}$/), revision: digest, bytes: z.number().int().nonnegative().max(REQUIREMENT_FILE_BYTES), roles: z.array(z.enum(['standard', 'material'])).min(1).max(2).refine(values => new Set(values).size === values.length, '设计资料角色不能重复') }).strict()
export const requirementTargetSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code') }).strict(),
  z.object({ kind: z.literal('directory'), grantId: id }).strict()
])
export const requirementTargetSchema = z.object({ id, root: z.string().min(1).max(8192), selectedAt: z.number().int().nonnegative() }).strict()
export const requirementTaskSchema = z.object({ root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200), taskId: z.string().min(1).max(200), title, status: z.string().min(1).max(100) }).strict()
export const requirementPredecessorSchema = z.object({ version: z.literal(1), draftId: id, handoffCommandId: id, draftRevision: id, confirmedRevision: id, planRevision: id, bodyRevision: digest, manifestRevision: digest, task: z.object({ root: z.string().min(1).max(8192), taskDir: z.string().min(1).max(200), taskId: z.string().min(1).max(200) }).strict() }).strict()
export const requirementCreateSuccessorSchema = z.object({ commandId: id, expectedHandoffCommandId: id }).strict()
export const requirementReceiptSchema = z.object({
  commandId: id, draftId: id, draftRevision: id, targetId: id, state: z.enum(['created', 'partial', 'uncertain', 'not-admitted']),
  task: requirementTaskSchema.optional(), files: z.array(z.string().min(1).max(8192)).max(36), detail: z.string().max(2000).optional(), planRevision: id.optional(), confirmedRevision: id.optional()
}).strict()
export const requirementDraftSchema = z.object({
  id, conversationId: id, creatorId: z.string().min(1).max(256), title, body, revision: id, bodyRevision: digest,
  relativePath: z.string().min(1).max(8192), references: z.array(requirementReferenceSchema).max(8), designContext: requirementDesignContextSchema.optional(), designContextFiles: z.array(requirementDesignSnapshotSchema).max(16).default([]),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), target: requirementTargetSchema.optional(), handoff: requirementReceiptSchema.optional(), predecessor: requirementPredecessorSchema.optional(),
  questions: questions.default([]), confirmed: requirementConfirmedSchema.optional(), plan: requirementPlanSchema.optional(), operations: z.array(requirementOperationSchema).max(REQUIREMENT_OPERATIONS_LIMIT).default([])
}).strict()
export const requirementCreateSchema = z.object({ commandId: id, title: title.default('需求草稿'), body: body.default(''), references: selections.default([]), designContext: requirementDesignContextSchema.optional() }).strict()
export const requirementSaveSchema = z.object({ expectedRevision: id, title, body, references: selections, designContext: requirementDesignContextSchema.optional(), questions: questions.optional(), expectedFileRevision: digest.nullable().optional(), resolvePending: z.literal(true).optional() }).strict()
export const requirementSyncSchema = z.object({ expectedRevision: id, fileRevision: digest }).strict()
export const requirementResolveConflictSchema = z.object({ expectedRevision: id, document: requirementDocumentSchema, expectedPlanRevision: id.nullable().optional(), expectedFileRevision: digest.nullable(), decision: z.enum(['keep-local', 'use-file']), body: body.optional() }).strict().superRefine((value, context) => {
  if (value.document === 'plan' && value.expectedPlanRevision === undefined) context.addIssue({ code: 'custom', path: ['expectedPlanRevision'], message: '计划冲突需要原计划版本' })
  if (value.document === 'requirement' && value.expectedPlanRevision !== undefined) context.addIssue({ code: 'custom', path: ['expectedPlanRevision'], message: '需求冲突不能指定计划版本' })
  if (value.decision === 'keep-local' && value.body === undefined) context.addIssue({ code: 'custom', path: ['body'], message: '保留本地稿需要明确提交正文' })
})
export const requirementTargetInputSchema = z.object({ expectedRevision: id, selection: requirementTargetSelectionSchema }).strict()
export const requirementCommitSchema = z.object({ expectedRevision: id, expectedPlanRevision: id, commandId: id, targetId: id, knowledgeOperationIds: z.array(id).max(REQUIREMENT_OPERATIONS_LIMIT).refine(values => new Set(values).size === values.length, '来源操作不能重复').optional(), knowledgeSources: z.array(requirementHandoffSourceSchema).max(128).refine(values => new Set(values.map(value => JSON.stringify([value.operationId, value.sourceId, value.returnedRevision]))).size === values.length, '交接来源不能重复').optional(), directKnowledge: requirementDirectKnowledgeSchema.optional(), designSources: designHandoffSources.optional() }).strict()
export const requirementTaskOriginSchema = z.object({ version: z.literal(1), conversationId: id, creatorId: z.string().min(1).max(256), draftId: id, draftRevision: id, commandId: id, bodyRevision: digest, manifestRevision: digest, manifestPath: z.literal('references/conversation-requirement.json'), confirmedRevision: id.optional(), sourceDigest: digest.optional(), planRevision: id.optional(), planBodyRevision: digest.optional(), planSourceRevision: id.optional(), predecessor: requirementPredecessorSchema.optional() }).strict()

export type RequirementFileSelection = z.infer<typeof requirementFileSelectionSchema>
export type RequirementReference = z.infer<typeof requirementReferenceSchema>
export type RequirementDesignSnapshot = z.infer<typeof requirementDesignSnapshotSchema>
export type RequirementDesignEvidence = z.infer<typeof requirementDesignEvidenceSchema>
export type RequirementDesignHandoffSource = z.infer<typeof requirementDesignStandardSchema>
export type RequirementTargetSelection = z.infer<typeof requirementTargetSelectionSchema>
export type RequirementTarget = z.infer<typeof requirementTargetSchema>
export type RequirementTask = z.infer<typeof requirementTaskSchema>
export type RequirementReceipt = z.infer<typeof requirementReceiptSchema>
export type RequirementDraft = z.infer<typeof requirementDraftSchema>
export type RequirementCreate = z.input<typeof requirementCreateSchema>
export type RequirementCreateSuccessor = z.infer<typeof requirementCreateSuccessorSchema>
export type RequirementPredecessor = z.infer<typeof requirementPredecessorSchema>
export type RequirementSave = z.infer<typeof requirementSaveSchema>
export type RequirementSync = z.infer<typeof requirementSyncSchema>
export type RequirementResolveConflict = z.infer<typeof requirementResolveConflictSchema>
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
export type RequirementApplySelection = z.infer<typeof requirementApplySelectionSchema>
export type RequirementSelectionReceipt = z.infer<typeof requirementSelectionReceiptSchema>
export const requirementPolishRunSchema = z.object({ commandId: id, expectedRevision: id, expectedPlanRevision: id.optional(), document: requirementDocumentSchema, quote: requirementQuoteSchema, text: z.string().trim().min(1).max(4000) }).strict()
export const requirementPolishObservationSchema = z.object({ id, document: requirementDocumentSchema, sourceRevision: id, sourceBodyRevision: digest, state: z.enum(['running', 'candidate', 'cancelled', 'failed', 'adopted', 'unknown']), candidateRevision: digest.optional(), replacement: body.optional(), detail: z.string().max(2000).optional(), receipt: requirementSelectionReceiptSchema.optional() }).strict()
export type RequirementPolishRun = z.infer<typeof requirementPolishRunSchema>
export type RequirementPolishObservation = z.infer<typeof requirementPolishObservationSchema>
export type RequirementHandoffSource = z.infer<typeof requirementHandoffSourceSchema>
export type RequirementDirectKnowledge = z.infer<typeof requirementDirectKnowledgeSchema>
export type RequirementKnowledgeGrant = z.infer<typeof requirementKnowledgeGrantSchema>
export type RequirementConfirm = z.infer<typeof requirementConfirmSchema>
export type RequirementSavePlan = z.infer<typeof requirementSavePlanSchema>
export type RequirementTaskOrigin = z.infer<typeof requirementTaskOriginSchema>
export type RequirementSummary = Omit<RequirementDraft, 'body' | 'references' | 'plan' | 'operations'> & { referenceCount: number; hasPlan: boolean; planStale: boolean }
export interface RequirementView { draft: RequirementDraft; confirmationCurrent?: boolean; fileState: 'saved' | 'changed' | 'missing' | 'unavailable'; fileRevision?: string; fileBody?: string; detail?: string; planFileState?: 'saved' | 'changed' | 'missing' | 'unavailable'; planFileRevision?: string; planFileBody?: string; pendingSave?: { document: RequirementDocument; draft: RequirementDraft; actual: { state: 'matches-previous' | 'matches-pending' | 'changed' | 'missing' | 'unavailable'; revision?: string; body?: string; detail?: string } }; recoveredFiles?: Array<{ document: RequirementDocument; path: string; revision: string }>; handoffHistory?: Array<{ receipt: RequirementReceipt; knowledgeOperationIds?: string[]; knowledgeSources?: RequirementHandoffSource[]; directKnowledge?: RequirementDirectKnowledge; designSources?: RequirementDesignHandoffSource[] }> }
export interface RequirementObservation { operation: RequirementOperation; candidate?: RequirementCandidate }
export type RequirementRunResult = { ok: true; value: RequirementObservation } | (IpcFail & { outcome?: 'not-admitted'; notSent?: true })
export interface RequirementOpen { conversationId: string; draftId: string; task: RequirementTask; taskDir: string; snapshot: ProjectSnapshot }
export interface ConversationRequirementsApi {
  polish: {
    run(conversationId: string, draftId: string, input: RequirementPolishRun): Promise<ConversationResult<RequirementPolishObservation>>
    observe(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementPolishObservation>>
    cancel(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementPolishObservation>>
    apply(conversationId: string, draftId: string, operationId: string, input: RequirementApplySelection): Promise<ConversationResult<{ view: RequirementView; receipt: RequirementSelectionReceipt }>>
  }
  knowledge: {
    connections(conversationId: string): Promise<ConversationResult<RequirementKnowledgeConnectionChoice[]>>
    collections(conversationId: string, input: RequirementKnowledgeConnection): Promise<ConversationResult<{ items: RequirementKnowledgeCollection[]; hasMore: boolean }>>
    search(conversationId: string, input: RequirementKnowledgeSearchInput): Promise<ConversationResult<RequirementKnowledgeSearchResult>>
  }
  list(conversationId: string): Promise<ConversationResult<RequirementSummary[]>>
  create(conversationId: string, input: RequirementCreate): Promise<ConversationResult<RequirementView>>
  createSuccessor(conversationId: string, originalDraftId: string, input: RequirementCreateSuccessor): Promise<ConversationResult<RequirementView>>
  read(conversationId: string, draftId: string): Promise<ConversationResult<RequirementView>>
  save(conversationId: string, draftId: string, input: RequirementSave): Promise<ConversationResult<RequirementView>>
  sync(conversationId: string, draftId: string, input: RequirementSync): Promise<ConversationResult<RequirementView>>
  resolveConflict(conversationId: string, draftId: string, input: RequirementResolveConflict): Promise<ConversationResult<RequirementView>>
  target(conversationId: string, draftId: string, input: RequirementTargetInput): Promise<ConversationResult<RequirementView>>
  run(conversationId: string, draftId: string, input: RequirementRun): Promise<RequirementRunResult>
  observe(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementObservation>>
  evidence(conversationId: string, draftId: string, operationId: string): Promise<ConversationResult<RequirementKnowledgeSnapshot[]>>
  adopt(conversationId: string, draftId: string, operationId: string, input: RequirementAdopt): Promise<ConversationResult<RequirementView>>
  applySelection(conversationId: string, draftId: string, operationId: string, input: RequirementApplySelection): Promise<ConversationResult<{ view: RequirementView; receipt: RequirementSelectionReceipt }>>
  confirmRequirement(conversationId: string, draftId: string, input: RequirementConfirm): Promise<ConversationResult<RequirementView>>
  savePlan(conversationId: string, draftId: string, input: RequirementSavePlan): Promise<ConversationResult<RequirementView>>
  commit(conversationId: string, draftId: string, input: RequirementCommit): Promise<ConversationResult<RequirementReceipt>>
  open(conversationId: string, draftId: string): Promise<ConversationResult<RequirementOpen>>
  prepareExecution(conversationId: string, draftId: string, input: import('./conversation-requirement-execution').RequirementExecutionPrepare): Promise<ConversationResult<import('./conversation-requirement-execution').RequirementExecutionPreparation>>
}
