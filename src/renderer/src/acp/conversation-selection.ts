import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import type { WorkspaceView } from './view-state'

export function isDiagnosticConversation(session: AcpSessionRecord): boolean {
  return /(?:^|[-_])(mock|diagnostic|fixture)(?:$|[-_])/i.test(session.runtimeSnapshot?.id ?? session.agentId)
}

export function isMeaningfulConversation(session: AcpSessionRecord): boolean {
  return !isDiagnosticConversation(session) && session.events.some((event) =>
    event.source === 'acp' && ((event.kind === 'message' && Boolean(event.text?.trim())) || event.kind === 'tool-call' || event.kind === 'permission'))
}

export function resolveWorkspaceEntry(view: WorkspaceView | undefined, activeId: string | null, sessions: AcpSessionRecord[]): { view: WorkspaceView; activeId: string | null } {
  const session = sessions.find((item) => item.sessionId === activeId)
  if (view === 'agents' || view === 'history') return { view, activeId: session?.sessionId ?? null }
  return session && isMeaningfulConversation(session) ? { view: 'conversation', activeId: session.sessionId } : { view: 'agents', activeId: null }
}

export function conversationSummary(session: AcpSessionRecord): string {
  const inScope = (event: TimelineEvent): boolean => event.source === 'acp' &&
    (!event.sessionId || event.sessionId === session.sessionId) &&
    (!event.projectRoot || projectRootKey(event.projectRoot) === projectRootKey(session.projectRoot))
  let last = session.events.length - 1
  for (; last >= 0; last -= 1) {
    const event = session.events[last]
    if (inScope(event) && event.kind === 'message' && messageRole(event) !== null && event.text?.trim()) break
  }
  const message = session.events[last]
  if (!message) return '暂无对话内容'
  const chunks = [message.text ?? '']
  // User prompts are whole messages. Assistant output is streamed; producer message
  // IDs are correlation hints, while role/turn/connection boundaries remain intact.
  if (messageRole(message) === 'assistant') {
    for (let index = last - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (!inScope(event)) continue
      if (event.kind === 'turn-done') break
      if (event.kind !== 'message') continue
      if (messageRole(event) !== 'assistant' || event.turnId !== message.turnId ||
        event.connectionGeneration !== message.connectionGeneration || event.payload?.messageId !== message.payload?.messageId) break
      chunks.push(event.text ?? '')
    }
  }
  return chunks.reverse().join('').replace(/\s+/g, ' ').trim().slice(0, 180) || '暂无对话内容'
}

function messageRole(event: TimelineEvent): 'user' | 'assistant' | null {
  const role = event.payload?.role
  return role === undefined || role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : null
}
