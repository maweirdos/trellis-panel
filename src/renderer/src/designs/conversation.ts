import type { DesignDocument, DesignSelection } from '@shared/design-workspace'
import { useSyncExternalStore } from 'react'
import { conversationClient, conversationValue } from '../conversations/client'
import { showPrivateConversation } from '../conversations/private-navigation'
import { editDraft, patchEntry, readConversation, requestComposerFocus, saveDraft, selectConversation, sessionRunning, useConversations } from '../conversations/workspace'
import { projectRootKey } from '../my/navigation'
import { requireDesignClient } from './client'
import { useDesignNavigation } from './navigation'

export interface DesignConversationReference { documentId: string; revision: string; title: string; selection?: DesignSelection; validate?(): Promise<boolean> }
export interface PendingDesignSend { requestId: string; text: string; version: number; reference: DesignConversationReference }
const pendingSends = new Map<string, PendingDesignSend>()
const listeners = new Set<() => void>()
const pendingKey = (entryKey: string, owner?: string): string => JSON.stringify([owner, entryKey])
const publishPending = (): void => { for (const listener of listeners) listener() }
export function usePendingDesignSend(entryKey: string, owner?: string): PendingDesignSend | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => pendingSends.get(pendingKey(entryKey, owner)) ?? null)
}

export async function openDesignConversation(document: Pick<DesignDocument, 'id' | 'conversationId'>, selection?: DesignSelection): Promise<void> {
  const client = conversationClient()
  if (!client) throw new Error('本机会话接口当前不可用。')
  const read = conversationValue(await client.read(document.conversationId))
  const key = selectConversation(read.conversation)
  useDesignNavigation.setState({ conversationTarget: { conversationId: document.conversationId, documentId: document.id, selection, token: crypto.randomUUID() } })
  showPrivateConversation(read.conversation.kind)
  requestComposerFocus(key)
}

/** Uses the original private composer, model, permissions, stop and native owner. */
export async function sendDesignMessage(entryKey: string, reference: DesignConversationReference): Promise<boolean> {
  const entry = useConversations.getState().entries[entryKey]
  if (!entry || entry.locked || entry.action || !entry.loaded || !entry.conversation) return false
  const owner = entry.owner, conversationId = entry.conversation.id
  const key = pendingKey(entryKey, owner), old = pendingSends.get(key)
  if (!old && (sessionRunning(entry) || !entry.text.trim())) return false
  if (!old && entry.images?.length) throw new Error('设计修改暂不支持图片附件，图片和输入已保留。')
  const operation = old ?? { requestId: crypto.randomUUID(), text: entry.text.trim(), version: entry.version, reference }
  const owns = (): boolean => { const latest = useConversations.getState().entries[entryKey]; return Boolean(latest && !latest.locked && latest.owner === owner && latest.conversation?.id === conversationId) }
  patchEntry(entryKey, { action: 'sending', error: undefined, following: true })
  try {
    await saveDraft(entryKey, true)
    const document = conversationValue(await requireDesignClient().get({ documentId: operation.reference.documentId }))
    if (document.conversationId !== conversationId || !owns()) throw new Error('设计来源会话已变化，请核对原会话。')
    // An uncertain send may already have produced a newer document or unloaded
    // its preview. Recovery reconciles its original request, never a new target.
    if (!old && document.revision !== operation.reference.revision) throw new Error('设计已变化，请重新打开画布选择目标。')
    if (!old && operation.reference.selection && (!operation.reference.validate || !await operation.reference.validate())) throw new Error('页面选区已变化，请重新选择后发送。')
    if (!owns()) return false
    const session = useConversations.getState().entries[entryKey]?.session
    patchEntry(entryKey, { request: session ? { requestId: operation.requestId, projectRoot: session.projectRoot, sessionId: session.sessionId, connectionGeneration: session.connectionGeneration, previousTurnId: session.turnId, phase: 'submitting' } : undefined })
    pendingSends.set(key, operation)
    publishPending()
    const response = await requireDesignClient().send({ documentId: operation.reference.documentId, requestId: operation.requestId, text: operation.text, ...(operation.reference.selection ? { selection: operation.reference.selection } : {}) })
    if (!response.ok) {
      if (response.requestId === operation.requestId && response.notSent === true && response.outcomeUnknown !== true) { pendingSends.delete(key); publishPending() }
      throw new Error(response.error)
    }
    const receipt = response.value
    if (!owns()) return false
    if (receipt.conversationId !== conversationId || receipt.requestId !== operation.requestId || projectRootKey(receipt.session.projectRoot) !== projectRootKey(entry.conversation.workspace.root) || entry.conversation.nativeRef && receipt.session.sessionId !== entry.conversation.nativeRef.sessionId) throw new Error('设计发送回执来源不匹配，请核对原会话。')
    pendingSends.delete(key)
    publishPending()
    patchEntry(entryKey, value => ({ session: (value.session?.stateRevision ?? 0) > (receipt.session.stateRevision ?? 0) ? value.session : receipt.session,
      request: { requestId: operation.requestId, projectRoot: receipt.session.projectRoot, sessionId: receipt.session.sessionId, connectionGeneration: receipt.session.connectionGeneration, previousTurnId: session?.turnId, turnId: receipt.turnId, phase: 'accepted' } }))
    if (useConversations.getState().entries[entryKey]?.version === operation.version) editDraft(entryKey, '')
    void readConversation(entryKey)
    return true
  } finally { if (owns()) { patchEntry(entryKey, { action: undefined }); void readConversation(entryKey) } }
}
