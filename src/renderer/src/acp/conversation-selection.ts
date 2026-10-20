import type { AcpSessionRecord } from '../../../shared/types'
import { acpConversationPreview } from '../../../shared/acp-conversation-preview'
import type { WorkspaceView } from './view-state'

export function isDiagnosticConversation(session: AcpSessionRecord): boolean {
  return /(?:^|[-_])(mock|diagnostic|fixture)(?:$|[-_])/i.test(session.runtimeSnapshot?.id ?? session.agentId)
}

export function isMeaningfulConversation(session: AcpSessionRecord): boolean {
  return !isDiagnosticConversation(session) && (('hasConversation' in session && session.hasConversation === true) || session.events.some((event) =>
    event.source === 'acp' && ((event.kind === 'message' && Boolean(event.text?.trim())) || event.kind === 'tool-call' || event.kind === 'permission'))
  )
}

export function resolveWorkspaceEntry(view: WorkspaceView | undefined, activeId: string | null, sessions: AcpSessionRecord[]): { view: WorkspaceView; activeId: string | null } {
  const session = sessions.find((item) => item.sessionId === activeId)
  if (view === 'agents') return { view, activeId: session?.sessionId ?? null }
  if (view === 'history') return { view: 'conversation', activeId: session?.sessionId ?? null }
  // An explicitly opened new conversation stays open across renderer refreshes,
  // even before its first message. Unselected/diagnostic empty records stay out.
  if (view === 'conversation' && session && !isDiagnosticConversation(session)) return { view, activeId: session.sessionId }
  return session && isMeaningfulConversation(session) ? { view: 'conversation', activeId: session.sessionId } : { view: 'agents', activeId: null }
}

export function conversationSummary(session: AcpSessionRecord): string {
  return session.conversationPreview?.trim() || acpConversationPreview(session.events, session.sessionId, session.projectRoot)?.text || '暂无对话内容'
}
