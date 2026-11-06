import { z } from 'zod'
import { designFrameSchema, designPagesSchema } from '../../../shared/design-workspace'
import { designGenerationOutputSchema } from '../../../shared/design-generation'
import { conversationSendSchema } from '../../../shared/private-conversations'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type { PrivateConversations } from '../private-conversations/service'

const id = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const title = z.string().trim().min(1).max(200)
const timestamp = z.number().int().nonnegative()
export const designSnapshotSchema = z.object({
  revision: digest, title, pages: designPagesSchema, frames: z.array(designFrameSchema).max(8)
}).strict()
export const designSourceSchema = z.object({
  eventId: z.string().min(1).max(512), sessionId: z.string().min(1).max(200), connectionGeneration: z.string().min(1).max(200), turnId: z.string().min(1).max(200),
  toolCallId: z.string().min(1).max(512), output: designGenerationOutputSchema,
  manifestRevision: digest, manifestIdentity: digest,
  pages: z.array(z.object({ path: z.string().min(1).max(512), revision: digest, identity: digest }).strict()).min(1).max(8)
}).strict()
export const designRecordSchema = z.object({
  version: z.literal(1), id, creatorId: z.string().min(1).max(256), conversationId: id, sourceIdentity: digest,
  conversationRoot: z.string().min(1).max(8192), rootIdentity: z.string().min(1).max(256), nativeSessionId: z.string().min(1).max(200),
  currentRevision: digest, updatedAt: timestamp,
  history: z.array(z.object({ revision: digest, createdAt: timestamp, reason: z.enum(['generated', 'save', 'adopt']) }).strict()).min(1).max(64),
  candidates: z.array(z.object({ id, baseRevision: digest, revision: digest, createdAt: timestamp }).strict()).max(16),
  sources: z.array(designSourceSchema).min(1).max(256),
  receipts: z.array(z.object({ commandId: id, digest, revision: digest }).strict()).max(256)
}).strict()
export const designIntentSchema = z.object({
  version: z.literal(1), conversationId: id, creatorId: z.string().min(1).max(256), sourceIdentity: digest,
  kind: z.enum(['web', 'app', 'prototype']), documentId: id.optional(), createdAt: timestamp
}).strict()
export const designScanSchema = z.object({
  version: z.literal(1), conversationId: id, sourceIdentity: digest, nativeSessionId: z.string().min(1).max(200), afterCursor: z.string().max(4096).optional(),
  rejectedEvents: z.array(z.string().min(1).max(512)).max(256).default([]),
  placeholderRecoveryVersion: z.union([z.literal(1), z.literal(2)]).optional()
}).strict()
export const designRequestSchema = z.object({
  version: z.literal(1), conversationId: id, creatorId: z.string().min(1).max(256), sourceIdentity: digest,
  requestId: id, originalDigest: digest, input: conversationSendSchema,
  displayText: z.string().min(1).max(16_000), documentId: id.optional(), baseRevision: digest.optional()
}).strict()
export type DesignSnapshot = z.infer<typeof designSnapshotSchema>
export type DesignRecord = z.infer<typeof designRecordSchema>
export type DesignSource = z.infer<typeof designSourceSchema>
export type DesignIntent = z.infer<typeof designIntentSchema>
export type DesignRequest = z.infer<typeof designRequestSchema>
export type DesignOwner = Awaited<ReturnType<PrivateConversations['workspaceAccess']>>
export type DesignPorts = {
  directory(): string
  conversations: PrivateConversations
  chooseSave?(input: { title: string; format: 'source' | 'prototype'; defaultName: string }): Promise<string | null>
}
export class DesignWorkspaceError extends Error {
  constructor(message: string, readonly code: IpcFail['code'] = IpcErrorCode.Conflict,
    readonly receipt?: { requestId: string; notSent?: boolean; outcomeUnknown?: boolean; outcome?: string }) { super(message) }
}
