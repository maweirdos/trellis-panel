import type { Conversation } from '@shared/private-conversations'
import type { RequirementDocument } from '@shared/conversation-requirements'
import { projectRootKey } from '../../my/navigation'

export interface RequirementReadingPosition { rich: number; source: number; mode: 'rich' | 'source' }
interface Location { document: RequirementDocument; positions: Partial<Record<RequirementDocument, RequirementReadingPosition>> }
const ownerKey = (conversation: Conversation): string => JSON.stringify([conversation.creatorId, conversation.id, projectRootKey(conversation.workspace.root)])
const key = (conversation: Conversation, id: string): string => `tpanel.requirement-reading.v1.${ownerKey(conversation)}.${id}`
const lastKey = (conversation: Conversation): string => `tpanel.requirement-last.v1.${ownerKey(conversation)}`
const cache = new Map<string, Location>()
export function lastRequirementId(conversation: Conversation | undefined): string | undefined {
  if (!conversation) return
  try { return localStorage.getItem(lastKey(conversation)) ?? undefined } catch { return }
}
export function rememberRequirement(conversation: Conversation, id: string): void {
  try { localStorage.setItem(lastKey(conversation), id) } catch { /* Reading remains available when preference storage is full. */ }
}
export function requirementReadingLocation(conversation: Conversation, id: string): Location {
  const identity = key(conversation, id), saved = cache.get(identity)
  if (saved) return saved
  const value: Location = { document: 'requirement', positions: {} }
  try {
    const raw = JSON.parse(localStorage.getItem(identity) ?? 'null')
    if (raw?.document === 'plan') value.document = 'plan'
    for (const document of ['requirement', 'plan'] as const) {
      const position = raw?.positions?.[document]
      if (position && Number.isFinite(position.rich) && position.rich >= 0 && position.rich <= 10_000_000 && Number.isFinite(position.source) && position.source >= 0 && position.source <= 10_000_000 && ['rich', 'source'].includes(position.mode)) value.positions[document] = position
    }
  } catch { /* A missing reading preference does not invalidate the document. */ }
  if (cache.size >= 128) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest) }
  cache.set(identity, value)
  return value
}
export function rememberRequirementReading(conversation: Conversation, id: string, document: RequirementDocument, position?: RequirementReadingPosition): void {
  const location = requirementReadingLocation(conversation, id)
  location.document = document
  if (position) location.positions[document] = position
  rememberRequirement(conversation, id)
  try { localStorage.setItem(key(conversation, id), JSON.stringify(location)) } catch { /* Preserve the in-memory position. */ }
}
