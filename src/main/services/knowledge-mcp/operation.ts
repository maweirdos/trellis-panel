import { createHash } from 'node:crypto'
import type { KnowledgeConversationInput } from '../../../shared/knowledge-conversation'
import type { KnowledgeOwner } from '../knowledge-access/types'

function payload(input: KnowledgeConversationInput): unknown {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value
  const normalized = input.kind === 'save_document' ? { ...input, sourceIds: [...new Set(input.sourceIds ?? [])].sort() } : input
  return ordered(normalized)
}
export function conversationPayloadHash(input: KnowledgeConversationInput): string {
  return createHash('sha256').update(JSON.stringify(payload(input))).digest('hex')
}
export function conversationOperationId(owner: KnowledgeOwner, input: KnowledgeConversationInput): string {
  const hash = createHash('sha256').update(JSON.stringify([owner.root, owner.sessionId, owner.turnId, payload(input)])).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
