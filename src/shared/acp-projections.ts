import { z } from 'zod'

export const ACP_PROJECTION_VERSION = 1
export const ACP_PROJECTION_DEFAULT_ITEMS = 100

const boundedId = z.string().min(1).max(200).regex(/^[\w.-]+$/)
const timestampMs = z.number().int().nonnegative().safe()

export const acpConversationProjectionCursorSchema = z.object({
  sequence: z.number().int().nonnegative().safe(),
  scope: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
}).strict()
export type AcpConversationProjectionCursor = z.infer<typeof acpConversationProjectionCursorSchema>

export const acpConversationListInputSchema = z.object({
  archive: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: acpConversationProjectionCursorSchema.nullable().default(null),
  query: z.string().trim().max(200).default(''),
}).strict()
export type AcpConversationListInput = Omit<z.input<typeof acpConversationListInputSchema>, 'root'>

export const acpConversationDetailInputSchema = z.object({
  sessionId: boundedId,
  itemLimit: z.number().int().min(1).max(200).default(ACP_PROJECTION_DEFAULT_ITEMS),
}).strict()
export type AcpConversationDetailInput = z.infer<typeof acpConversationDetailInputSchema>

export const acpConversationEventsInputSchema = z.object({
  sessionId: boundedId,
  after: z.number().int().nonnegative().safe(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict()
export type AcpConversationEventsInput = z.infer<typeof acpConversationEventsInputSchema>

export const acpConversationRuntimeStateSchema = z.enum([
  'stopped', 'recoverable', 'running', 'awaiting-permission', 'stopping', 'unknown',
])
export type AcpConversationRuntimeState = z.infer<typeof acpConversationRuntimeStateSchema>

export const acpConversationRuntimeProjectionSchema = z.object({
  state: acpConversationRuntimeStateSchema,
  lastObservedAt: timestampMs.nullable(),
  recoverable: z.boolean(),
  engine: z.enum(['acp', 'pi']),
  providerInstanceId: z.string().min(1).max(200),
  runtimeSessionId: z.string().min(1).max(200),
}).strict()
export type AcpConversationRuntimeProjection = z.infer<typeof acpConversationRuntimeProjectionSchema>

export const acpConversationListItemSchema = z.object({
  conversationId: z.string().min(1).max(200),
  sourceSessionId: boundedId,
  sourceEngine: z.enum(['acp', 'pi']),
  root: z.string().min(1).max(8192),
  title: z.string().max(300),
  status: z.enum(['active', 'archived', 'deleted']),
  runtime: acpConversationRuntimeProjectionSchema,
  lastActivityAt: timestampMs,
  createdAt: timestampMs,
  updatedAt: timestampMs,
  lastSequence: z.number().int().positive().safe(),
}).strict()
export type AcpConversationListItem = z.infer<typeof acpConversationListItemSchema>

export const acpConversationListSnapshotSchema = z.object({
  ok: z.literal(true),
  version: z.literal(ACP_PROJECTION_VERSION),
  conversations: z.array(acpConversationListItemSchema).max(100),
  nextCursor: acpConversationProjectionCursorSchema.nullable(),
  hasMore: z.boolean(),
  snapshotSequence: z.number().int().nonnegative().safe(),
}).strict()
export type AcpConversationListSnapshot = z.infer<typeof acpConversationListSnapshotSchema>

export const acpTurnItemVariantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('assistant-message'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('reasoning'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('tool-call'), title: z.string().max(2000), status: z.string().max(120).optional() }).strict(),
  z.object({ kind: z.literal('permission'), title: z.string().max(2000), pending: z.boolean() }).strict(),
  z.object({ kind: z.literal('plan'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('status'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('diagnostic'), text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal('image'), count: z.number().int().positive().max(1000) }).strict(),
  z.object({ kind: z.literal('usage'), text: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('system-marker'), text: z.string().max(2000) }).strict(),
])
export type AcpTurnItemVariant = z.infer<typeof acpTurnItemVariantSchema>

export const acpTurnItemProjectionSchema = z.object({
  id: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative().safe(),
  sourceEventId: z.string().min(1).max(200),
  sourceSequence: z.number().int().positive().safe(),
  occurredAt: timestampMs,
  sequence: z.number().int().positive().safe(),
  item: acpTurnItemVariantSchema,
}).strict()
export type AcpTurnItemProjection = z.infer<typeof acpTurnItemProjectionSchema>

export const acpConversationHistoryCoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'unknown']),
  sourceEventCount: z.number().int().nonnegative().safe(),
  projectedEventCount: z.number().int().nonnegative().safe(),
  capturedFrom: timestampMs.nullable(),
  capturedThrough: timestampMs.nullable(),
  reason: z.string().max(2000).optional(),
}).strict()
export type AcpConversationHistoryCoverage = z.infer<typeof acpConversationHistoryCoverageSchema>

export const acpConversationDetailSnapshotSchema = z.object({
  ok: z.literal(true),
  version: z.literal(ACP_PROJECTION_VERSION),
  conversation: acpConversationListItemSchema,
  turnItems: z.array(acpTurnItemProjectionSchema).max(200),
  hasEarlierItems: z.boolean(),
  earlierHistoryCursor: z.number().int().nonnegative().safe(),
  pendingRequests: z.array(z.object({ kind: z.string().max(100), summary: z.string().max(2000) }).strict()).max(20),
  coverage: acpConversationHistoryCoverageSchema,
  snapshotSequence: z.number().int().nonnegative().safe(),
}).strict()
export type AcpConversationDetailSnapshot = z.infer<typeof acpConversationDetailSnapshotSchema>

export const acpConversationProjectionEventSchema = z.object({
  sequence: z.number().int().positive().safe(),
  conversationId: z.string().min(1).max(200),
  type: z.enum(['conversation-created', 'conversation-updated', 'turn-updated', 'item-updated', 'runtime-updated', 'migration-completed']),
  occurredAt: timestampMs,
  item: acpTurnItemProjectionSchema.optional(),
}).strict()
export type AcpConversationProjectionEvent = z.infer<typeof acpConversationProjectionEventSchema>

export const acpConversationEventPageSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    version: z.literal(ACP_PROJECTION_VERSION),
    events: z.array(acpConversationProjectionEventSchema).max(200),
    nextCursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
    conversation: acpConversationListItemSchema.optional(),
    coverage: acpConversationHistoryCoverageSchema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    version: z.literal(ACP_PROJECTION_VERSION),
    resetRequired: z.literal(true),
    reason: z.enum(['cursor-ahead', 'conversation-reset', 'store-reset']),
    snapshotSequence: z.number().int().nonnegative().safe(),
  }).strict(),
])
export type AcpConversationEventPage = z.infer<typeof acpConversationEventPageSchema>

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id)
  if (index === -1) {
    return [...items, next]
  }

  const updated = [...items]
  updated[index] = next
  return updated
}

export function applyConversationEventPage(
  snapshot: AcpConversationDetailSnapshot,
  page: Extract<AcpConversationEventPage, { ok: true }>,
): AcpConversationDetailSnapshot | undefined {
  const conversation = page.conversation ?? snapshot.conversation
  if (conversation.conversationId !== snapshot.conversation.conversationId
    || conversation.sourceSessionId !== snapshot.conversation.sourceSessionId
    || conversation.root !== snapshot.conversation.root || page.nextCursor < snapshot.snapshotSequence) return undefined

  let turnItems = snapshot.turnItems
  for (const event of page.events) {
    if (event.conversationId !== conversation.conversationId || (event.item !== undefined && event.item.conversationId !== conversation.conversationId)) return undefined
    if (event.sequence <= snapshot.snapshotSequence || event.item === undefined) continue
    if (event.sequence > page.nextCursor || event.item.sequence !== event.sequence) return undefined
    if (snapshot.hasEarlierItems && event.item.sourceSequence < snapshot.earlierHistoryCursor) continue
    turnItems = upsertById(turnItems, event.item)
  }
  if (turnItems === snapshot.turnItems && conversation === snapshot.conversation && page.coverage === undefined) {
    return page.nextCursor === snapshot.snapshotSequence ? snapshot : { ...snapshot, snapshotSequence: page.nextCursor }
  }
  const hasEarlierItems = snapshot.hasEarlierItems || turnItems.length > ACP_PROJECTION_DEFAULT_ITEMS
  const latest = turnItems === snapshot.turnItems ? turnItems : turnItems
    .sort((left, right) => left.sourceSequence - right.sourceSequence)
    .slice(-ACP_PROJECTION_DEFAULT_ITEMS)
  return {
    ...snapshot,
    conversation,
    turnItems: latest,
    hasEarlierItems,
    earlierHistoryCursor: latest[0]?.sourceSequence ?? 0,
    pendingRequests: latest.flatMap(({ item }) =>
      item.kind === 'permission' && item.pending ? [{ kind: 'permission', summary: item.title }] : []).slice(-20),
    coverage: {
      ...(page.coverage ?? snapshot.coverage),
      capturedFrom: latest[0]?.occurredAt ?? null,
      capturedThrough: latest.at(-1)?.occurredAt ?? null,
    },
    snapshotSequence: page.nextCursor,
  }
}
