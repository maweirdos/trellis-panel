import { z } from 'zod'
import type { AcpHistoryEventPage } from './acp-history'
import type { AcpSessionRecord } from './types'
import type { IpcFail } from './ipc-errors'
import { ACP_IMAGE_MIME_TYPES, ACP_IMAGE_MAX_BASE64 } from './acp-images'

const id = z.string().uuid()
const name = z.string().trim().min(1).max(200)
export const conversationIdSchema = id
export const conversationSchema = z.object({
  id, creatorId: z.string().min(1).max(256), title: name, kind: z.enum(['work', 'code']),
  projectId: z.string().min(1).max(256).optional(),
  workspace: z.object({ root: z.string().min(1).max(8192), kind: z.enum(['managed', 'directory']) }).strict(),
  nativeRef: z.object({ sessionId: z.string().min(1).max(200), agentId: z.string().min(1).max(200) }).strict().optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  pinnedAt: z.number().int().nonnegative().optional(), archivedAt: z.number().int().nonnegative().optional(),
  conversationPreview: z.string().min(1).max(500).optional()
}).strict()
export const conversationCreateDraftSchema = z.object({
  kind: z.enum(['work', 'code']).default('work'),
  projectId: z.string().min(1).max(256).optional(), directoryGrantId: id.optional(),
  runtimeId: z.string().min(1).max(200).optional(), text: z.string().max(200_000).default('')
}).strict()
export const conversationUpdateDraftSchema = z.object({
  text: z.string().max(200_000).optional(), title: name.optional(), runtimeId: z.string().min(1).max(200).optional(),
  directoryGrantId: id.optional(), pinned: z.boolean().optional(), archived: z.boolean().optional()
}).strict().refine(value => Object.keys(value).length > 0, '请选择要更新的草稿字段')
export const conversationListSchema = z.object({
  kind: z.enum(['work', 'code']).optional(), archive: z.enum(['active', 'archived', 'all']).default('active'),
  projectId: z.string().min(1).max(256).optional(), query: z.string().max(200).optional()
}).strict()
export const conversationSendSchema = z.object({
  requestId: id, text: z.string().max(200_000),
  images: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(500), mimeType: z.enum(ACP_IMAGE_MIME_TYPES), data: z.string().min(1).max(ACP_IMAGE_MAX_BASE64) }).strict()).max(8).optional(),
  expectedConnectionGeneration: z.string().min(1).max(200).optional()
}).strict()
export const conversationRespondSchema = z.object({
  requestId: z.string().min(1).max(200), optionId: z.string().min(1).max(1000), expectedConnectionGeneration: z.string().min(1).max(200)
}).strict()
export const conversationConnectionSchema = z.object({ expectedConnectionGeneration: z.string().min(1).max(200).optional() }).strict()
export const conversationReclassifySchema = z.object({ projectId: z.string().min(1).max(256).nullable() }).strict()
export const conversationProjectSchema = z.object({ id: z.string().min(1).max(256), name }).strict()
export const conversationCreateProjectSchema = z.object({ name }).strict()
export const conversationFileSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(500), relativePath: z.string().min(1).max(8192),
  kind: z.enum(['input', 'output']), bytes: z.number().int().nonnegative(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  modifiedAt: z.number().finite()
}).strict()
export const conversationOpenFileSchema = z.object({ fileId: z.string().min(1).max(256), action: z.enum(['open', 'reveal']).default('open') }).strict()
export const conversationReadFileSchema = z.object({ fileId: z.string().min(1).max(256), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export type Conversation = z.infer<typeof conversationSchema>
export type ConversationCreateDraft = z.input<typeof conversationCreateDraftSchema>
export type ConversationUpdateDraft = z.infer<typeof conversationUpdateDraftSchema>
export type ConversationList = z.input<typeof conversationListSchema>
export type ConversationSend = z.infer<typeof conversationSendSchema>
export type ConversationRespond = z.infer<typeof conversationRespondSchema>
export type ConversationConnection = z.infer<typeof conversationConnectionSchema>
export type ConversationReclassify = z.infer<typeof conversationReclassifySchema>
export type ConversationProject = z.infer<typeof conversationProjectSchema>
export type ConversationCreateProject = z.input<typeof conversationCreateProjectSchema>
export type ConversationFile = z.infer<typeof conversationFileSchema>
export type ConversationOpenFile = z.input<typeof conversationOpenFileSchema>
export type ConversationReadFile = z.infer<typeof conversationReadFileSchema>
export type ConversationResult<T> = { ok: true; value: T } | IpcFail
export interface ConversationRead {
  conversation: Conversation
  draft: { text: string; runtimeId?: string }
  session?: AcpSessionRecord
  runtimeError?: string
}
export interface ConversationDirectoryGrant { grantId: string; path: string }
export interface ConversationApi {
  list(input?: ConversationList): Promise<ConversationResult<Conversation[]>>
  createDraft(input?: ConversationCreateDraft): Promise<ConversationResult<ConversationRead>>
  updateDraft(id: string, input: ConversationUpdateDraft): Promise<ConversationResult<ConversationRead>>
  read(id: string): Promise<ConversationResult<ConversationRead>>
  events(id: string, input?: { before?: string; after?: string; limit?: number }): Promise<ConversationResult<AcpHistoryEventPage | null>>
  send(id: string, input: ConversationSend): Promise<ConversationResult<{ conversation: Conversation; session: AcpSessionRecord; turnId: string }>>
  respond(id: string, input: ConversationRespond): Promise<ConversationResult<null>>
  cancel(id: string, input?: ConversationConnection): Promise<ConversationResult<null>>
  end(id: string, input?: ConversationConnection): Promise<ConversationResult<null>>
  configure(id: string, input: import('./acp-configuration').ConversationConfigure): Promise<ConversationResult<AcpSessionRecord>>
  recoverModel(id: string, input: import('./acp-configuration').ConversationRecoverModel): Promise<ConversationResult<AcpSessionRecord>>
  pickDirectory(input?: { purpose: 'code' | 'trellis-requirement' }): Promise<ConversationResult<ConversationDirectoryGrant | null>>
  git(id: string): Promise<ConversationResult<import('./conversation-git').ConversationGitStatus>>
  requirements: import('./conversation-requirements').ConversationRequirementsApi
  pickFiles(id: string): Promise<ConversationResult<ConversationFile[]>>
  files(id: string): Promise<ConversationResult<ConversationFile[]>>
  openFile(id: string, input: ConversationOpenFile): Promise<ConversationResult<null>>
  readFile(id: string, input: ConversationReadFile): Promise<ConversationResult<{ name: string; body: string; kind: 'prototype' | 'document'; revision: string; modifiedAt: number }>>
  image(id: string, imageId: string): Promise<ConversationResult<{ mimeType: import('./acp-images').AcpImageMimeType; data: string }>>
  saveImage(id: string, imageId: string): Promise<ConversationResult<{ cancelled: boolean }>>
  projects(): Promise<ConversationResult<ConversationProject[]>>
  createProject(input: ConversationCreateProject): Promise<ConversationResult<ConversationProject>>
  reclassify(id: string, input: ConversationReclassify): Promise<ConversationResult<ConversationRead>>
}

/** Native GUI transport only; renderer methods never accept these owner/path fields. */
export const privateNativeOwnerSchema = z.object({
  root: z.string().min(1).max(8192), sessionId: z.string().regex(/^acp-private-[a-f0-9-]{36}$/),
  conversationId: id, creatorId: z.string().min(1).max(256)
}).strict()
export const privateNativeReadSchema = privateNativeOwnerSchema.extend({
  operation: z.enum(['session', 'events', 'image', 'updates', 'receipt']),
  requestId: z.string().uuid().optional(),
  after: z.object({ epoch: z.string().uuid(), sequence: z.number().int().nonnegative().safe() }).strict().nullable().optional(),
  paging: z.object({ before: z.string().max(4096).optional(), after: z.string().max(4096).optional(), limit: z.number().int().min(1).max(500).optional() }).strict().optional(),
  imageId: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()
export const privateNativeSendSchema = privateNativeOwnerSchema.extend({ operation: z.enum(['prepare', 'send']), agentId: z.string().min(1).max(200), input: conversationSendSchema }).strict()
export const privateNativeControlSchema = privateNativeOwnerSchema.extend({
  expectedConnectionGeneration: z.string().min(1).max(200).optional(),
  requestId: z.string().min(1).max(200).optional(), optionId: z.string().min(1).max(1000).optional()
}).strict()
export type PrivateNativeOwner = z.infer<typeof privateNativeOwnerSchema>
