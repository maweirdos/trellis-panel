import type { TimelineEvent } from './types'

export type ConversationTextPhase = 'commentary' | 'final_answer'
export interface ConversationTextBlock {
  version: 1
  messageId: string
  blockIndex: number
  blockType: 'text' | 'thinking'
  operation: 'append' | 'replace'
  providerMessageId?: string
  authority?: 'block_end' | 'message_end'
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Validate persisted updates independently of the live private transport. */
export function readConversationTextBlock(event: TimelineEvent): ConversationTextBlock | undefined {
  const meta = object(event.payload?.meta)
  const block = object(event.source === 'pi' ? meta?.piText : event.source === 'acp' ? meta?.acpText : undefined)
  if (![event.projectRoot, event.sessionId, event.connectionGeneration, event.turnId].every(value => typeof value === 'string' && Boolean(value.trim())) ||
    !block || typeof event.text !== 'string' || block.version !== 1 || typeof block.messageId !== 'string' || !block.messageId.trim() || block.messageId !== event.payload?.messageId ||
    !Number.isSafeInteger(block.blockIndex) || Number(block.blockIndex) < 0 || block.blockType !== 'text' && block.blockType !== 'thinking' ||
    block.operation !== 'append' && block.operation !== 'replace' || (block.blockType === 'thinking' ? 'thought' : 'message') !== event.kind || event.payload?.role === 'user' ||
    block.providerMessageId !== undefined && (typeof block.providerMessageId !== 'string' || !block.providerMessageId.trim()) ||
    block.authority !== undefined && block.authority !== 'block_end' && block.authority !== 'message_end' || block.operation === 'replace' && !block.authority ||
    meta?.phase !== undefined && meta.phase !== 'commentary' && meta.phase !== 'final_answer') return undefined
  return block as unknown as ConversationTextBlock
}

/** Use this before transcript, title, preview, search or handoff text extraction.
 * Originals remain append-only; each projected block retains its first event anchor.
 * A replacement without a loaded prefix is a complete, independently readable block.
 */
export function replayConversationTextEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const projected: TimelineEvent[] = []
  const blocks = new Map<string, number>()
  const seen = new Set<string>()
  for (const event of events) {
    const meta = object(event.payload?.meta)
    if ((event.source === 'pi' ? meta?.piText : event.source === 'acp' ? meta?.acpText : undefined) === undefined) { projected.push(event); continue }
    const block = readConversationTextBlock(event)
    // Invalid structured replacements must not fall back to ordinary text appends.
    if (!block) continue
    const owner = [event.source, event.projectRoot, event.sessionId, event.connectionGeneration, event.turnId]
    const eventKey = JSON.stringify([...owner, event.id])
    if (seen.has(eventKey)) continue
    seen.add(eventKey)
    const key = JSON.stringify([...owner, block.messageId, block.blockIndex, block.blockType])
    const index = blocks.get(key)
    if (index === undefined) {
      blocks.set(key, projected.length)
      projected.push({ ...event, payload: { ...event.payload, meta: { ...meta } } })
    } else {
      const previous = projected[index]
      const nextMeta = { ...object(previous.payload?.meta), ...meta }
      if (block.authority && meta?.phase === undefined) delete nextMeta.phase
      projected[index] = { ...previous, text: block.operation === 'replace' ? event.text ?? '' : (previous.text ?? '') + (event.text ?? ''),
        payload: { ...previous.payload, ...event.payload, meta: nextMeta } }
    }
  }
  return projected
}
