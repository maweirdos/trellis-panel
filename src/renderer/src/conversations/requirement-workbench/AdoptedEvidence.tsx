import { useEffect, useRef, useState, type JSX } from 'react'
import { BookOpen, ChevronDown, Loader2 } from 'lucide-react'
import type { RequirementOperation } from '@shared/conversation-requirements'
import { requirementKnowledgeSourceSnapshotSchema, type RequirementKnowledgeSourceSnapshot } from '@shared/conversation-requirement-knowledge'
import { Button } from '../../my/ui'
import { projectRootKey } from '../../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { useConversations } from '../workspace'

const capturedDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })

export function AdoptedEvidence({ entryKey, draftId, operation }: { entryKey: string; draftId: string; operation: RequirementOperation }): JSX.Element {
  const current = useConversations(state => state.entries[entryKey]), active = useInteractionActive(), signal = useInteractionSignal(), canInteract = useInteractionGuard()
  const identity = JSON.stringify([entryKey, draftId, operation.id, operation.commandId, operation.sourceDigest, operation.knowledge, current?.owner, current?.conversation?.id, current?.conversation?.creatorId, current?.conversation?.workspace.root, current?.session?.connectionGeneration, active])
  const owner = useRef({ identity, signal })
  if (owner.current.identity !== identity || owner.current.signal !== signal) owner.current = { identity, signal }
  const [open, setOpen] = useState(false), [sources, setSources] = useState<RequirementKnowledgeSourceSnapshot[]>(), [pending, setPending] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), request = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  useEffect(() => { request.current++; setOpen(false); setSources(undefined); setPending(false); setError('') }, [identity, signal])
  const read = async (): Promise<void> => {
    const original = useConversations.getState().entries[entryKey], captured = owner.current
    if (pending || !active || !canInteract() || !isPrivateEntrySelected(entryKey) || original?.locked || !original?.conversation || operation.state !== 'adopted' || !operation.knowledge.length) return
    const ticket = ++request.current, conversation = original.conversation
    const valid = (): boolean => {
      const latest = useConversations.getState().entries[entryKey]
      return mounted.current && owner.current === captured && request.current === ticket && canInteract() && isPrivateEntrySelected(entryKey) && !latest?.locked && latest?.owner === original.owner && latest?.conversation?.id === conversation.id && latest.conversation.creatorId === conversation.creatorId && projectRootKey(latest.conversation.workspace.root) === projectRootKey(conversation.workspace.root) && latest.session?.connectionGeneration === original.session?.connectionGeneration
    }
    setPending(true); setError('')
    try {
      const api = conversationClient()?.requirements
      if (!api?.evidence) throw new Error('来源读取接口暂不可用，请重试。')
      const returned = conversationValue(await api.evidence(conversation.id, draftId, operation.id))
      if (!valid()) return
      if (returned.length > 8 || returned.length !== operation.knowledge.length) throw new Error('已采用来源记录不完整，请重试读取原摘录。')
      const snapshots = returned.map(source => requirementKnowledgeSourceSnapshotSchema.parse(source))
      if (new Set(snapshots.map(source => source.sourceId)).size !== snapshots.length || snapshots.some(source => {
        const recorded = operation.knowledge.find(item => item.sourceId === source.sourceId && item.returnedRevision === source.returnedRevision)
        return !recorded || recorded.connectionId !== source.selection.connectionId || recorded.collectionId !== source.collectionId || recorded.documentId !== source.documentId || recorded.contentHash !== source.contentHash || recorded.truncated !== source.truncated
      })) throw new Error('返回摘录与当时采用的来源不一致，未展示其他资料。')
      setSources(snapshots)
    } catch (cause) { if (valid()) { setSources(undefined); setError(conversationError(cause)) } }
    finally { if (valid()) setPending(false) }
  }
  return <details open={open} onToggle={event => {
    const next = event.currentTarget.open; setOpen(next)
    if (next && !sources && !pending && !error) void read()
  }}>
    <summary className="requirement-workbench-disclosure"><BookOpen size={14} aria-hidden="true" /><span className="my-item-title">已采用来源</span><span className="my-item-description">{operation.knowledge.length} 项</span><ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="requirement-workbench-source-body">
      {pending && <p className="my-activity-note" role="status"><Loader2 size={13} className="animate-spin" />读取当时的资料摘录…</p>}
      {error && <div role="alert" className="requirement-workbench-inline-error"><span className="my-item-title">已采用来源暂不可读取</span><Button size="sm" variant="outline" disabled={!active || pending} onClick={() => void read()}>重试读取</Button><details><summary className="my-item-description">原因</summary><pre>{error}</pre></details></div>}
      {sources && <div className="requirement-workbench-evidence">{sources.map(source => <article key={`${source.sourceId}:${source.returnedRevision}`} className="requirement-workbench-evidence-row"><h3 className="my-item-title">{source.title}</h3><p className="my-item-description">采集于 <time dateTime={new Date(source.fetchedAt).toISOString()}>{capturedDate.format(source.fetchedAt)}</time>{source.truncated ? ' · 已截取' : ''}</p><blockquote>{source.excerpt}</blockquote></article>)}</div>}
    </div>
  </details>
}
