import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { BookmarkPlus, X } from 'lucide-react'
import { Button, Modal } from '../my/ui'
import { confirmDialog } from '../components/Dialogs'
import { ProductMaterialActions, type ProductMaterialDraftSeed, type ProductMaterialDraftState } from '../knowledge/ProductMaterialActions'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from '../knowledge/bridge'
import { InteractionScope, useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { projectRootKey } from '../my/navigation'
import { useEscLayer } from '../utils/use-esc-layer'
import type { KnowledgeSource } from '../../../shared/knowledge-access'

// Retain unsaved edits only in this renderer process and only for the exact answer owner.
const drafts = new Map<string, { state: ProductMaterialDraftState; sources: KnowledgeSource[] }>()

function AnswerEscapeLayer({ onClose }: { onClose: () => void }): null {
  const id = useId()
  useEscLayer(true, { id: `answer-close-${id}`, kind: 'modal', onClose })
  return null
}

export function SaveKnowledgeAnswerAction({ root, sessionId, connectionGeneration, turnId, messageId, body }: { root: string; sessionId: string; connectionGeneration: string; turnId: string; messageId: string; body: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const owner = useKnowledgeOwner(root, sessionId)
  const draftKey = JSON.stringify([projectRootKey(root), sessionId, connectionGeneration, turnId, messageId, body])
  useEffect(() => { if (!interactive) setOpen(false) }, [interactive])
  return <>
    <Button size="sm" variant="ghost" onClick={() => { if (owner.current() && canInteract()) setOpen(true) }}><BookmarkPlus size={13} />保存到知识</Button>
    {open && interactive && <InteractionScope active><SaveKnowledgeAnswerModal root={root} sessionId={sessionId} turnId={turnId} messageId={messageId} body={body} draftKey={draftKey} onClose={() => setOpen(false)} /></InteractionScope>}
  </>
}

function SaveKnowledgeAnswerModal({ root, sessionId, turnId, messageId, body, draftKey, onClose }: { root: string; sessionId: string; turnId: string; messageId: string; body: string; draftKey: string; onClose: () => void }): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const restored = useRef(drafts.get(draftKey)).current
  const dirty = useRef(Boolean(restored))
  const busy = useRef(false)
  const confirming = useRef(false)
  const live = useRef(false)
  const [closeNotice, setCloseNotice] = useState('')
  const [escapeEpoch, setEscapeEpoch] = useState(0)
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const seed = useMemo<ProductMaterialDraftSeed>(() => ({ id: messageId, root, sessionId, turnId, title: 'Agent 回答', body, kind: 'confirmed-note', sourceIds: sources?.map((source) => source.id) ?? [] }), [messageId, root, sessionId, turnId, body, sources])
  useLayoutEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const updateDraft = useCallback((state: ProductMaterialDraftState, changed: boolean, running: boolean): void => {
    dirty.current = changed; busy.current = running
    if (changed && sources) drafts.set(draftKey, { state, sources })
    else if (!changed) drafts.delete(draftKey)
  }, [draftKey, sources])
  const close = async (): Promise<void> => {
    if (!live.current || !owner.current() || !canInteract()) return
    if (confirming.current) return
    if (busy.current) { setCloseNotice('操作正在进行，请等待结果后再关闭。'); setEscapeEpoch((value) => value + 1); return }
    if (!dirty.current) { drafts.delete(draftKey); onClose(); return }
    confirming.current = true
    try {
      const confirmed = await confirmDialog({ title: '放弃未保存的修改？', message: '标题、正文及来源的未保存修改将被丢弃。', confirmText: '放弃修改', danger: true }, signal)
      if (confirmed && live.current && owner.current() && canInteract() && !signal?.aborted && !busy.current) { drafts.delete(draftKey); onClose() }
      else if (live.current && owner.current() && canInteract() && !signal?.aborted) setEscapeEpoch((value) => value + 1)
    } finally { confirming.current = false }
  }
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      if (!owner.current() || !canInteract()) return
      const bridge = knowledgeBridge(['sources'])
      if (!bridge) { setSourceError(knowledgeUnavailableFor('会话来源读取')); return }
      setSourceError('')
      try {
        const records = requireKnowledge(await bridge.sources(owner.input))
        if (live && owner.current() && canInteract()) {
          const matched = records.filter((source) => source.sessionId === sessionId && source.turnId === turnId && source.suppliedToAgent)
          const previous = restored?.sources.filter((source) => source.sessionId === sessionId && source.turnId === turnId && source.suppliedToAgent) ?? []
          setSources([...matched, ...previous.filter((source) => !matched.some((item) => item.id === source.id))])
        }
      } catch (failure) { if (live && owner.current() && canInteract()) setSourceError(knowledgeError(failure, '会话来源读取')) }
    }
    void load()
    return () => { live = false }
  }, [owner.current, owner.input, canInteract, sessionId, turnId, attempt, restored])
  return <><Modal open onClose={() => void close()} width={760} ariaLabel="保存回答到知识">
    <div className="flex items-center justify-between border-b border-my-line px-4 py-3"><h2 className="text-my-base font-semibold">保存回答到知识</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={() => void close()}><X size={16} /></Button></div>
    <div className="my-scrollbar max-h-[70vh] overflow-y-auto p-4">
      <p className="mb-3 text-my-xs leading-relaxed text-my-secondary">本地文件保存在项目 .trellis/notes，可能随仓库共享。保存不会发布；远端发布需要另行预览和确认。</p>
      {closeNotice && <p role="status" className="mb-3 text-my-xs text-my-warning-text">{closeNotice}</p>}
      {sourceError ? <div className="space-y-2"><p role="alert" className="text-my-xs text-my-danger-text">{sourceError}</p><Button size="sm" onClick={() => setAttempt((value) => value + 1)}>重试读取来源</Button><Button size="sm" variant="ghost" onClick={() => { setSourceError(''); setSources(restored?.sources ?? []) }}>{restored ? '使用之前读取的来源继续' : '不关联来源继续'}</Button></div> : sources === null ? <p role="status" className="text-my-xs text-my-secondary">正在读取本轮持久来源…</p> : <><p className="mb-3 text-my-xs text-my-tertiary">仅显示已保存且提供给本轮 Agent 的来源；来源列表受读取限额约束。未保存修改仅暂留在当前应用进程。</p><ProductMaterialActions root={root} sessionId={sessionId} sources={sources} draftSeed={seed} allowCreate={false} restoredDraft={restored?.state} onDraftState={updateDraft} /></>}
    </div>
  </Modal><AnswerEscapeLayer key={escapeEpoch} onClose={() => void close()} /></>
}
