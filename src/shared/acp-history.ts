import { z } from 'zod'
import type { AcpPermissionPayload, AcpSessionMeta, TimelineEvent } from './types'

export const ACP_HISTORY_VERSION = 1
export const acpHistoryUpdateInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional()
}).strict().refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined,
  'At least one conversation preference is required')
export type AcpHistoryUpdateInput = z.infer<typeof acpHistoryUpdateInputSchema>
export type AcpHistoryUpdateResult = { ok: true; version: 1; session: AcpHistorySummary }
export const acpHistoryDeleteInputSchema = z.object({ token: z.string().uuid() }).strict()
export type AcpHistoryDeletePreview = { ok: true; sessionId: string; title: string; token: string; scope: string[]; excluded: string[] }
export type AcpHistoryDeleteResult = { ok: true; sessionId: string; deleted: true } | { ok: true; sessionId: string; cancelled: true }
export interface AcpTitleProvenance {
  source: 'manual' | 'generated' | 'fallback'
  revision: string
  state: 'pending' | 'ready' | 'failed'
  sourceDigest?: string
  model?: string
  generatedAt?: number
  error?: string
}
export const acpHistoryEventsInputSchema = z.object({
  before: z.string().max(4096).optional(),
  after: z.string().max(4096).optional(),
  tail: z.string().min(1).max(4096).optional(),
  // Soft event target: a complete conversational turn may exceed it.
  limit: z.number().int().min(1).max(500).optional()
}).refine(input => [input.before, input.after, input.tail].filter(Boolean).length <= 1).optional()
export type AcpHistoryEventsInput = NonNullable<z.infer<typeof acpHistoryEventsInputSchema>>

export type AcpHistoryCoverageState = 'complete' | 'unknown' | 'partial'
export interface AcpHistoryCoverage {
  state: AcpHistoryCoverageState
  capturedFrom: number | null
  reason?: string
  unarchivedCount?: number
}
export interface AcpHistoryPersistence {
  state: 'saved' | 'saving' | 'degraded'
  pendingCount: number
  committedThroughEventId: string | null
  committedThroughSeq: number | null
  error?: string
  unarchivedCount?: number
}
export interface AcpHistorySummary extends AcpSessionMeta {
  eventCount: number
  /** Whether the archive contains a real message/tool/permission, excluding diagnostics. */
  hasConversation: boolean
  lastActivityAt: number
  historyCoverage: AcpHistoryCoverage
  historyPersistence: AcpHistoryPersistence
  pendingPermissions: AcpPermissionPayload[]
  stateRevision: number
}
export interface AcpHistoryEventPage {
  ok: true
  version: typeof ACP_HISTORY_VERSION
  session: AcpHistorySummary
  events: Array<TimelineEvent & { historySeq?: number }>
  beforeCursor: string | null
  afterCursor: string | null
  resumeCursor?: string
  hasEarlier: boolean
  hasLater: boolean
  /** The saved source lacks a confirmed turn opening; normal paging never cuts one. */
  startsMidTurn: boolean
  /** An intact turn exceeds the page's soft event-count or byte target. */
  oversized: boolean
  coverage: AcpHistoryCoverage
  historyPersistence: AcpHistoryPersistence
  /** Text-only context is independent of the visible transcript page. Never merge into timeline events. */
  discussion?: { events: TimelineEvent[]; truncated: boolean }
}
export interface AcpHistoryPersistenceState extends AcpHistoryPersistence {
  sessionId: string
}
