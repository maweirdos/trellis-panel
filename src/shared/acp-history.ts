import { z } from 'zod'
import type { AcpPermissionPayload, AcpSessionMeta, TimelineEvent } from './types'

export const ACP_HISTORY_VERSION = 1
export const acpHistoryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).optional(),
  query: z.string().max(200).optional(),
  filter: z.enum(['all', 'resumable', 'transcript']).optional(),
  archive: z.enum(['active', 'archived', 'all']).optional()
}).optional()
export const acpHistoryUpdateInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional()
}).strict().refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined,
  'At least one conversation preference is required')
export type AcpHistoryUpdateInput = z.infer<typeof acpHistoryUpdateInputSchema>
export type AcpHistoryUpdateResult = { ok: true; version: 1; session: AcpHistorySummary }
export const acpHistoryEventsInputSchema = z.object({
  before: z.string().max(4096).optional(),
  after: z.string().max(4096).optional(),
  // Soft event target: a complete conversational turn may exceed it.
  limit: z.number().int().min(1).max(500).optional()
}).optional()

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
export interface AcpHistoryDiagnostic { code: string; message: string; source?: string }
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
export interface AcpHistoryListResult {
  ok: true
  version: typeof ACP_HISTORY_VERSION
  sessions: AcpHistorySummary[]
  nextCursor: string | null
  hasMore: boolean
  snapshotId: string
  searchScope: 'metadata'
  diagnostics: AcpHistoryDiagnostic[]
}
export interface AcpHistoryEventPage {
  ok: true
  version: typeof ACP_HISTORY_VERSION
  session: AcpHistorySummary
  events: Array<TimelineEvent & { historySeq?: number }>
  beforeCursor: string | null
  afterCursor: string | null
  hasEarlier: boolean
  hasLater: boolean
  /** The saved source lacks a confirmed turn opening; normal paging never cuts one. */
  startsMidTurn: boolean
  /** An intact turn exceeds the page's soft event-count or byte target. */
  oversized: boolean
  coverage: AcpHistoryCoverage
  historyPersistence: AcpHistoryPersistence
}
export interface AcpHistoryPersistenceState extends AcpHistoryPersistence {
  sessionId: string
}
