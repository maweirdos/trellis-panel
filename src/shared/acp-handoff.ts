import { z } from 'zod'

export const ACP_HANDOFF_CONTEXT_BYTE_LIMIT = 32 * 1024
const id = z.string().min(1).max(200).regex(/^[\w.-]+$/)
const count = z.number().int().nonnegative().safe()
export const acpHandoffSessionIdSchema = id
export const acpHandoffOperationIdSchema = z.string().uuid()

export const acpHandoffContextSchema = z.string().min(1).max(ACP_HANDOFF_CONTEXT_BYTE_LIMIT)
  .refine(value => value.trim().length > 0 && !value.includes('\0'), '请提供有效的交接内容')
  .refine(value => new TextEncoder().encode(value).length <= ACP_HANDOFF_CONTEXT_BYTE_LIMIT, '交接内容不能超过 32 KiB')
export const acpHandoffPreviewInputSchema = z.object({ targetRuntimeId: id }).strict()
export const acpHandoffCreateInputSchema = z.object({
  operationId: acpHandoffOperationIdSchema, previewId: id, context: acpHandoffContextSchema
}).strict()
export const acpHandoffCancelInputSchema = z.object({ operationId: acpHandoffOperationIdSchema }).strict()
export type AcpHandoffPreviewInput = z.infer<typeof acpHandoffPreviewInputSchema>
export type AcpHandoffCreateInput = z.infer<typeof acpHandoffCreateInputSchema>
export type AcpHandoffCancelInput = z.infer<typeof acpHandoffCancelInputSchema>

export const acpHandoffStateSchema = z.enum(['creating', 'ready', 'sent', 'failed', 'cancelled'])
export const acpHandoffDeliverySchema = z.enum(['prepared', 'sent', 'not_sent'])
export type AcpHandoffState = z.infer<typeof acpHandoffStateSchema>
export type AcpHandoffDelivery = z.infer<typeof acpHandoffDeliverySchema>

export const acpHandoffPreviewSchema = z.object({
  id,
  source: z.object({ sessionId: id, title: z.string().max(500), runtimeId: id, runtimeName: z.string().max(200),
    checkpointEventId: z.string().min(1).max(300), checkpointSeq: z.number().int().positive().safe() }).strict(),
  target: z.object({ runtimeId: id, name: z.string().min(1).max(200) }).strict(),
  cwd: z.string().min(1).max(8192), context: acpHandoffContextSchema,
  includedMessages: count, omittedMessages: count, attachments: count, toolCalls: count,
  truncated: z.boolean(), latestTurnIncluded: z.boolean(), coverage: z.enum(['complete', 'partial', 'unknown']),
  contextByteLimit: z.literal(ACP_HANDOFF_CONTEXT_BYTE_LIMIT)
}).strict()
export type AcpHandoffPreview = z.infer<typeof acpHandoffPreviewSchema>

export const acpHandoffOperationSchema = z.object({
  id: acpHandoffOperationIdSchema, sourceSessionId: id, targetSessionId: id.optional(), targetRuntimeId: id,
  state: acpHandoffStateSchema, sourceArchived: z.boolean(), delivery: acpHandoffDeliverySchema,
  createdAt: count, updatedAt: count, error: z.string().max(2000).optional()
}).strict()
export type AcpHandoffOperation = z.infer<typeof acpHandoffOperationSchema>
export type AcpHandoffPreviewResult = { ok: true; version: 1; preview: AcpHandoffPreview }
export type AcpHandoffOperationResult = { ok: true; version: 1; operation: AcpHandoffOperation }

/** Public provenance only. Actual context bytes stay in the daemon-owned operation record. */
export interface AcpHandoffOrigin {
  operationId: string
  sourceSessionId: string
  sourceTitle: string
  sourceRuntimeId: string
  checkpointEventId: string
  checkpointSeq: number
  contextRevision: string
  contextBytes: number
  createdAt: number
  includedMessages: number
  omittedMessages: number
  attachments: number
  toolCalls: number
  truncated: boolean
  latestTurnIncluded: boolean
  coverage: 'complete' | 'partial' | 'unknown'
  delivery: AcpHandoffDelivery
  sentAt?: number
  deliveryConnectionGeneration?: string
  deliveryTurnId?: string
}
export interface AcpHandoffTargetLink {
  operationId: string
  targetSessionId: string
  runtimeId: string
  createdAt: number
  state: AcpHandoffState
}
