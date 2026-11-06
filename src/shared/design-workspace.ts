import { z } from 'zod'
import type { ConversationRead } from './private-conversations'
import type { AcpSessionRecord } from './types'
import type { IpcFail } from './ipc-errors'
import { designGenerationPageIdSchema, designGenerationPageInputSchema, DESIGN_GENERATION_MAX_PAGES, DESIGN_GENERATION_PAGE_MAX_BYTES, DESIGN_GENERATION_TOTAL_MAX_BYTES } from './design-generation'

export { DESIGN_GENERATION_PAGE_MAX_BYTES as DESIGN_PAGE_BYTES, DESIGN_GENERATION_TOTAL_MAX_BYTES as DESIGN_TOTAL_BYTES, DESIGN_GENERATION_MAX_PAGES as DESIGN_MAX_PAGES } from './design-generation'
const id = z.string().uuid()
const pageId = designGenerationPageIdSchema
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const dimension = designGenerationPageInputSchema.shape.width
const title = z.string().trim().min(1).max(200)
export const designPageSchema = z.object({
  id: pageId, title, html: z.string().min(1).max(DESIGN_GENERATION_PAGE_MAX_BYTES), width: dimension, height: dimension
}).strict()
export const designPagesSchema = z.array(designPageSchema).min(1).max(DESIGN_GENERATION_MAX_PAGES).superRefine((pages, context) => {
  if (new Set(pages.map(page => page.id.toLowerCase())).size !== pages.length) context.addIssue({ code: 'custom', message: '页面身份重复' })
  let bytes = 0
  for (const page of pages) {
    const size = new TextEncoder().encode(page.html).length
    bytes += size
    if (size > DESIGN_GENERATION_PAGE_MAX_BYTES) context.addIssue({ code: 'custom', message: '单页 HTML 超过 128 KiB' })
  }
  if (bytes > DESIGN_GENERATION_TOTAL_MAX_BYTES) context.addIssue({ code: 'custom', message: '设计 HTML 总大小超过 512 KiB' })
})
export const designFrameSchema = z.object({
  id: pageId, pageId, x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000), width: dimension, height: dimension
}).strict()
export const designSummarySchema = z.object({
  id, title, conversationId: id, updatedAt: z.number().int().nonnegative(), pageCount: z.number().int().min(1).max(DESIGN_GENERATION_MAX_PAGES), revision,
  readOnly: z.boolean().optional(), sourceError: z.string().max(2000).optional()
}).strict()
export const designConversationSummarySchema = designSummarySchema.extend({
  candidates: z.array(z.object({ id }).strict()).max(16)
}).strict()
export const designCandidateSchema = z.object({
  id, baseRevision: revision, revision, title, createdAt: z.number().int().nonnegative(), pages: designPagesSchema,
  frames: z.array(designFrameSchema).max(DESIGN_GENERATION_MAX_PAGES)
}).strict()
export const designHistorySchema = z.object({
  revision, title, createdAt: z.number().int().nonnegative(), reason: z.enum(['generated', 'save', 'adopt']),
  pages: designPagesSchema, frames: z.array(designFrameSchema).max(DESIGN_GENERATION_MAX_PAGES)
}).strict()
export const designDocumentSchema = designSummarySchema.extend({
  pages: designPagesSchema, frames: z.array(designFrameSchema).max(DESIGN_GENERATION_MAX_PAGES),
  candidates: z.array(designCandidateSchema).max(16), history: z.array(designHistorySchema).max(64)
}).strict()
export const designGetSchema = z.object({ documentId: id }).strict()
export const designSyncSchema = z.object({ conversationId: id }).strict()
export const designCreateConversationSchema = z.object({ kind: z.enum(['web', 'app', 'prototype']).optional(), text: z.string().max(16_000).optional() }).strict()
export const designSaveSchema = z.object({
  documentId: id, expectedRevision: revision, commandId: id, pages: designPagesSchema.optional(), frames: z.array(designFrameSchema).max(DESIGN_GENERATION_MAX_PAGES).optional()
}).strict().refine(value => value.pages !== undefined || value.frames !== undefined, '请选择要保存的页面或布局')
export const designSelectionSchema = z.object({
  pageId, frameId: pageId.optional(), revision, selector: z.string().min(1).max(2000),
  tagName: z.string().max(100).optional(), text: z.string().max(4000).optional(), outerHTML: z.string().max(16_000).optional()
}).strict()
export const designSendSchema = z.object({ documentId: id, requestId: id, text: z.string().trim().min(1).max(16_000), selection: designSelectionSchema.optional() }).strict()
export const designAdoptSchema = z.object({ documentId: id, candidateId: id, expectedRevision: revision, commandId: id }).strict()
export const designDiscardSchema = designAdoptSchema
export const designExportSchema = z.object({ documentId: id, format: z.enum(['source', 'prototype']), expectedRevision: revision.optional() }).strict()

export type DesignSummary = z.infer<typeof designSummarySchema>
export type DesignConversationSummary = z.infer<typeof designConversationSummarySchema>
export type DesignLibrary = { items: DesignSummary[]; incomplete: boolean }
export type DesignDocument = z.infer<typeof designDocumentSchema>
export type DesignPage = z.infer<typeof designPageSchema>
export type DesignFrame = z.infer<typeof designFrameSchema>
export type DesignCandidate = z.infer<typeof designCandidateSchema>
export type DesignHistory = z.infer<typeof designHistorySchema>
export type DesignSelection = z.infer<typeof designSelectionSchema>
export type DesignCreateConversation = z.infer<typeof designCreateConversationSchema>
export type DesignSave = z.infer<typeof designSaveSchema>
export type DesignSend = z.infer<typeof designSendSchema>
export type DesignAdopt = z.infer<typeof designAdoptSchema>
export type DesignDiscard = z.infer<typeof designDiscardSchema>
export type DesignExport = z.infer<typeof designExportSchema>
export type DesignSendFailure = IpcFail & { requestId?: string; notSent?: boolean; outcomeUnknown?: boolean; outcome?: string }
export type DesignResult<T> = { ok: true; value: T } | DesignSendFailure
export type DesignSendReceipt = { conversationId: string; requestId: string; session: AcpSessionRecord; turnId: string }
export interface DesignWorkspaceApi {
  list(): Promise<DesignResult<DesignLibrary>>
  get(input: { documentId: string }): Promise<DesignResult<DesignDocument>>
  listConversation(input: { conversationId: string }): Promise<DesignResult<DesignConversationSummary[]>>
  sync(input: { conversationId: string }): Promise<DesignResult<DesignDocument[]>>
  createConversation(input?: DesignCreateConversation): Promise<DesignResult<ConversationRead>>
  save(input: DesignSave): Promise<DesignResult<DesignDocument>>
  send(input: DesignSend): Promise<DesignResult<DesignSendReceipt>>
  adopt(input: DesignAdopt): Promise<DesignResult<DesignDocument>>
  discard(input: DesignDiscard): Promise<DesignResult<DesignDocument>>
  export(input: DesignExport): Promise<DesignResult<{ cancelled: boolean }>>
}
