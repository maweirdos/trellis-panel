import type { TimelineEvent } from './types'

export interface AcpConversationPreview {
  text: string
  at: number
}

/** True only for real user-visible conversation content, excluding diagnostics/metadata. */
export function hasAcpConversationContent(events: TimelineEvent[], sessionId?: string, projectRoot?: string): boolean {
  return events.some((event) => sameScope(event, sessionId, projectRoot) &&
    ((event.kind === 'message' && typeof event.text === 'string' && Boolean(event.text.trim())) || event.kind === 'tool-call' || event.kind === 'permission'))
}

function sameScope(event: TimelineEvent, sessionId?: string, projectRoot?: string): boolean {
  if (event.source !== 'acp') return false
  if (sessionId && event.sessionId && event.sessionId !== sessionId) return false
  if (projectRoot && event.projectRoot) {
    if (typeof event.projectRoot !== 'string') return false
    const key = (value: string): string => {
      const normalized = value.replace(/\\/g, '/').replace(/\/$/, '')
      return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
    }
    const left = key(event.projectRoot)
    const right = key(projectRoot)
    if (left !== right) return false
  }
  return true
}

function role(event: TimelineEvent): 'user' | 'assistant' | null {
  const value = event.payload?.role
  return value === 'user' ? 'user' : value === undefined || value === 'assistant' ? 'assistant' : null
}

/** Build a bounded coherent latest-message preview without retaining transcript bodies. */
export function acpConversationPreview(events: TimelineEvent[], sessionId?: string, projectRoot?: string): AcpConversationPreview | undefined {
  let index = events.length - 1
  for (; index >= 0; index -= 1) {
    const event = events[index]
    if (sameScope(event, sessionId, projectRoot) && event.kind === 'message' && role(event) !== null && typeof event.text === 'string' && event.text.trim()) break
  }
  const latest = events[index]
  if (!latest || latest.kind !== 'message' || typeof latest.text !== 'string' || !latest.text.trim()) return undefined
  const latestRole = role(latest)
  const chunks = [latest.text]
  if (latestRole === 'assistant') {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const event = events[cursor]
      if (!sameScope(event, sessionId, projectRoot)) continue
      if (event.kind === 'turn-done') break
      if (event.kind !== 'message') continue
      if (role(event) !== 'assistant' || event.turnId !== latest.turnId || event.connectionGeneration !== latest.connectionGeneration || event.payload?.messageId !== latest.payload?.messageId) break
      chunks.push(typeof event.text === 'string' ? event.text : '')
    }
  }
  const text = chunks.reverse().join('').replace(/\s+/g, ' ').trim().slice(0, 180)
  return text ? { text, at: latest.ts } : undefined
}
