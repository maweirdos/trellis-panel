import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ConversationKnowledgeReference } from '../../../shared/conversation/knowledge-reference'
import { useKnowledgeReferenceHandoff } from '../acp/knowledge-reference-handoff'
import { projectRootKey } from '../my/navigation'
import { Button } from '../my/ui'
import { requirementsDraftText, useKnowledgeRequest } from './request-intake'

export function ProjectConversationIntake({ root, enabled, canAppend, canAddReference, onAppend, onAddReference }: {
  root: string
  enabled: boolean
  canAppend: boolean
  canAddReference: boolean
  onAppend(text: string, newConversation: boolean): boolean
  onAddReference(knowledge: ConversationKnowledgeReference, isCurrent: () => boolean): Promise<boolean>
}): JSX.Element | null {
  const key = projectRootKey(root)
  const request = useKnowledgeRequest(state => state.draft && projectRootKey(state.draft.root) === key ? state.draft : null)
  const reference = useKnowledgeReferenceHandoff(state => state.pending && projectRootKey(state.pending.root) === key ? state.pending : null)
  const [failedRequest, setFailedRequest] = useState<string>()
  const [adding, setAdding] = useState<string>()
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  if (!request && !reference) return null

  return <div className="shrink-0 space-y-2 border-b border-my-line bg-my-layer-1 px-4 py-2">
    {request && <section className="space-y-1" aria-label="待加入的需求">
      <p className="my-item-title">{request.title}</p>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => add(true)}>放入新对话草稿</Button>
        {canAppend && <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => add(false)}>追加到当前草稿</Button>}
        <Button size="sm" variant="ghost" onClick={() => useKnowledgeRequest.getState().clear(request.id)}>取消</Button>
      </div>
      {failedRequest === request.id && <p role="alert" className="my-item-description">草稿超过长度限制或有发送待核对。待加入的需求已保留。</p>}
    </section>}
    {reference && <section className="space-y-1" aria-label="待加入的资料">
      <p className="my-item-title">{reference.title}</p>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" disabled={!enabled || !canAddReference || adding === reference.id}
          onClick={() => void addReference()}>{adding === reference.id ? '正在加入…' : '加入当前草稿'}</Button>
        <Button size="sm" variant="ghost" onClick={() => useKnowledgeReferenceHandoff.getState().clear(reference.id)}>取消</Button>
      </div>
    </section>}
  </div>

  function add(newConversation: boolean): void {
    if (!request || useKnowledgeRequest.getState().draft?.id !== request.id) return
    if (onAppend(requirementsDraftText(request), newConversation)) useKnowledgeRequest.getState().clear(request.id)
    else setFailedRequest(request.id)
  }

  async function addReference(): Promise<void> {
    if (!reference || adding === reference.id || !enabled || !canAddReference) return
    const store = useKnowledgeReferenceHandoff.getState
    const isCurrent = (): boolean => mounted.current && store().pending?.id === reference.id
    if (!isCurrent()) return
    setAdding(reference.id)
    try {
      if (await onAddReference(reference.knowledge, isCurrent) && isCurrent()) store().clear(reference.id)
    } finally {
      if (mounted.current) setAdding(current => current === reference.id ? undefined : current)
    }
  }
}
