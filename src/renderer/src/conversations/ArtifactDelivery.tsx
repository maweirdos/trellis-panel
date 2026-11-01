import { useEffect, useRef, useState, type JSX } from 'react'
import { Loader2, RotateCw, X } from 'lucide-react'
import type { Conversation, ConversationFile } from '@shared/private-conversations'
import { api } from '../api'
import { CreateCreationDialog } from '../creations/CreationDialogs'
import { openCreation } from '../creations/navigation'
import { useHifox } from '../hifox/store'
import { Button, Modal } from '../my/ui'

type Draft = { title: string; body: string; kind: 'document' | 'prototype' }

/** Only the selected, revision-checked file becomes a private material draft. */
export function ArtifactDelivery({ conversation, file, onClose }: {
  conversation: Conversation; file: ConversationFile; onClose: () => void
}): JSX.Element {
  const context = useHifox(state => state.workspaceContext)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const owner = useRef<string | null>(null)
  const identity = JSON.stringify([context.key, context.actorId, context.epoch])

  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setDraft(null)
    const load = async (): Promise<void> => {
      if (!api?.conversations) throw new Error('请在桌面应用中打开会话文件')
      if (!useHifox.getState().workspaceContext.actorId) await useHifox.getState().bootstrap()
      const source = useHifox.getState().workspaceContext
      if (!source.actorId || source.state === 'access-revoked') throw new Error('个人创作工作区尚未就绪，请重新载入')
      if (conversation.context.kind === 'team' && conversation.context.workspaceKey !== source.key) throw new Error('请先切回此会话关联的团队工作区，再整理材料')
      const sourceIdentity = JSON.stringify([source.key, source.actorId, source.epoch])
      if (owner.current && owner.current !== sourceIdentity) throw new Error('账户或工作区已改变，请关闭后重新选择文件')
      owner.current = sourceIdentity
      const result = await api.conversations.readFile(conversation.id, { fileId: file.id, expectedRevision: file.revision })
      if (!current) return
      if (!result.ok) throw new Error(result.error)
      const live = useHifox.getState().workspaceContext
      if (sourceIdentity !== JSON.stringify([live.key, live.actorId, live.epoch])) throw new Error('账户或工作区已改变，请重新选择文件')
      setDraft({ title: result.value.name.replace(/\.[^.]+$/, ''), kind: result.value.kind, body: result.value.body })
    }
    void load().catch(failure => { if (current) setError(failure instanceof Error ? failure.message : '无法读取所选文件') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [conversation.id, conversation.context.kind, conversation.context.kind === 'team' ? conversation.context.workspaceKey : '', file.id, file.revision, attempt])

  const changed = owner.current !== null && identity !== owner.current
  if (draft && !changed) return <CreateCreationDialog key={`${conversation.id}:${file.id}:${file.revision}:${identity}`}
    scope="personal" initialDraft={draft} onClose={onClose} onCreated={creationId => {
      const live = useHifox.getState().workspaceContext
      if (!live.actorId || identity !== JSON.stringify([live.key, live.actorId, live.epoch])) return
      onClose()
      openCreation({ workspaceKey: live.key, actorId: live.actorId, creationId, scope: 'personal' })
    }} />
  return <Modal open ariaLabel="整理会话产物" width={480} onClose={onClose}>
    <div className="space-y-4 p-5"><div className="flex items-center gap-3"><h2 className="my-item-title flex-1">整理为个人创作</h2><Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}><X size={15} /></Button></div>
      <p className="my-item-description break-all">{file.name}</p>
      {loading && !changed ? <p className="my-item-description flex items-center gap-2" role="status"><Loader2 size={14} className="animate-spin" />正在读取所选文件…</p> : <p role="alert" className="text-my-sm text-my-danger-text">{changed ? '账户或工作区已改变，请关闭后重新选择文件。' : error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>关闭</Button>{!loading && !changed && <Button onClick={() => setAttempt(value => value + 1)}><RotateCw size={14} />重新载入</Button>}</div>
    </div>
  </Modal>
}
