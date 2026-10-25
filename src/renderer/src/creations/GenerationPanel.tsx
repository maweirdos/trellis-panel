import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeftRight, Check, Loader2, Settings, Sparkles, Square, Trash2, X } from 'lucide-react'
import type { CreationGenerationPlan } from '@shared/creation-api'
import type { CreationView } from '@shared/creations'
import { Button, Modal } from '../my/ui'
import { useApp } from '../store'
import { creationApi, failureOf, needsRecovery, useCreationOwner, type CreationFailure, type useCreationCommands } from './hooks'

export function GenerationPanel({ view, selectedIds, dirty, commands, onUpdated, onCompare, onBusyChange }: {
  view: CreationView; selectedIds: string[]; dirty: boolean; commands: ReturnType<typeof useCreationCommands>
  onUpdated: () => Promise<void>; onCompare: () => void; onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const { workspaceKey, capture } = useCreationOwner(`ai:${view.summary.creationId}:${view.selected.revisionId}`)
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [plan, setPlan] = useState<{ value: CreationGenerationPlan; commandId: string; key: string } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'planning' | 'generating' | 'cancelling' | 'recovering'>('idle')
  const [error, setError] = useState<CreationFailure | null>(null)
  const running = useRef<{ workspaceKey: string; commandId: string } | null>(null)
  const operation = useRef(0)
  const busy = phase !== 'idle'
  const inputKey = JSON.stringify([view.summary.revision, selectedIds, instruction.trim()])
  const validPlan = plan?.key === inputKey ? plan : null
  const unknown = needsRecovery(error)
  const stale = Boolean(view.candidate && view.draft && view.candidate.baseDraftRevision !== view.draft.serial)
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  useEffect(() => () => {
    operation.current++
    const current = running.current
    if (current) void creationApi()?.cancelCandidate(current).catch(() => undefined)
  }, [])
  useEffect(() => {
    setPlan(null)
    const current = running.current
    if (current) {
      operation.current++
      running.current = null
      void creationApi()?.cancelCandidate(current).catch(() => undefined)
      setPhase('idle')
      setError({ code: 'REVISION_CONFLICT', error: '原稿已更新，请核对后重新生成' })
    }
  }, [view.summary.revision])
  const recordFailure = (failure: CreationFailure): void => {
    setError(failure)
    if (needsRecovery(failure)) commands.reportFailure(failure)
  }
  // A newer record head invalidates an estimate; input changes never call the model.
  const estimate = async (): Promise<void> => {
    if (busy || unknown || selectedIds.length < 1 || selectedIds.length > 8 || dirty) return
    const valid = capture()
    const ticket = ++operation.current
    const commandId = crypto.randomUUID()
    setPhase('planning'); setError(null)
    try {
      const reply = await creationApi()?.planCandidate({ workspaceKey, creationId: view.summary.creationId, expectedRevision: view.summary.revision, commandId, commentIds: selectedIds, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) })
      if (!valid() || ticket !== operation.current) return
      if (reply?.ok) setPlan({ value: reply.value, key: inputKey, commandId })
      else recordFailure(reply ?? { code: 'UNAVAILABLE', error: '当前环境未连接创作服务' })
    } catch (failure) { if (valid() && ticket === operation.current) setError(failureOf(failure)) }
    finally { if (valid() && ticket === operation.current) setPhase('idle') }
  }
  const generate = async (): Promise<void> => {
    if (busy || !validPlan?.value.available || unknown || dirty || commands.busy || commands.recoveryRequired) return
    const valid = capture()
    const ticket = ++operation.current
    const request = { workspaceKey, creationId: view.summary.creationId, commandId: validPlan.commandId, expectedRevision: view.summary.revision, commentIds: [...selectedIds], ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }
    running.current = { workspaceKey, commandId: request.commandId }
    setPhase('generating'); setError(null)
    try {
      const reply = await creationApi()?.generateCandidate(request)
      if (!valid() || ticket !== operation.current) return
      if (!reply?.ok) recordFailure(reply ?? { code: 'UNAVAILABLE', error: '当前环境未连接创作服务' })
      else { running.current = null; setPhase('idle'); setPlan(null); setOpen(false); await onUpdated(); if (valid()) onCompare() }
    } catch (failure) {
      if (valid() && ticket === operation.current) recordFailure({ ...failureOf(failure), outcomeUnknown: true })
    } finally {
      if (running.current?.commandId === request.commandId) running.current = null
      if (valid() && ticket === operation.current) setPhase('idle')
    }
  }
  const cancel = async (): Promise<void> => {
    const current = running.current
    if (!current || phase === 'cancelling') return
    const valid = capture()
    setPhase('cancelling')
    try {
      const reply = await creationApi()?.cancelCandidate(current)
      if (!valid()) return
      if (!reply?.ok) { setError(reply ?? { code: 'UNAVAILABLE', error: '停止请求失败' }); setPhase('generating'); return }
      if (reply.value.cancelled) { operation.current++; running.current = null; setPhase('idle'); setPlan(null); setError(null) }
      else {
        const awaitingResult = running.current?.commandId === current.commandId
        operation.current++; running.current = null; setPhase('idle'); setPlan(null)
        if (awaitingResult) recordFailure({ code: 'OUTCOME_UNKNOWN', error: '生成已结束，请核对原操作', outcomeUnknown: true })
        await onUpdated()
      }
    } catch (failure) { if (valid()) { setError(failureOf(failure)); setPhase('generating') } }
  }
  const recover = async (): Promise<void> => {
    const valid = capture()
    setPhase('recovering')
    try {
      const receipt = await commands.recover()
      if (!valid()) return
      if (receipt !== false) { setError(null); setPlan(null); await onUpdated() }
    } catch (failure) { if (valid()) setError({ ...failureOf(failure), outcomeUnknown: true }) }
    finally { if (valid()) setPhase('idle') }
  }
  return <>
    <div className="creation-ai-bar">
      {view.candidate ? <><Button size="sm" variant="ghost" onClick={onCompare}><ArrowLeftRight size={15} />比较 AI 候选</Button><span className="creation-grow" />
        {stale && <span className="creation-meta">原稿已变化</span>}
        <Button size="sm" disabled={commands.busy || commands.recoveryRequired || dirty || stale || busy} onClick={() => { void commands.run({ action: 'candidateAdopt', candidateId: view.candidate?.candidateId ?? '' }).then((result) => { if (result) void onUpdated() }) }}><Check size={14} />采用到草稿</Button>
        <Button size="sm" variant="ghost" disabled={commands.busy || commands.recoveryRequired || busy} aria-label="丢弃 AI 候选" onClick={() => { void commands.run({ action: 'candidateDiscard', candidateId: view.candidate?.candidateId ?? '' }).then((result) => { if (result) void onUpdated() }) }}><Trash2 size={14} /></Button></>
        : <><span className="creation-meta">已选 {selectedIds.length}/8 条批注</span><span className="creation-grow" /><Button size="sm" disabled={selectedIds.length === 0 || dirty || commands.busy || commands.recoveryRequired} onClick={() => setOpen(true)}><Sparkles size={14} />AI 修改</Button></>}
    </div>
    {busy && !open && <div className="creation-notice" role="status"><Loader2 size={14} className="creation-spinner" />{phase === 'planning' ? '正在估算用量' : phase === 'recovering' ? '正在核对原操作' : '正在生成候选'}<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>查看</Button></div>}
    <Modal open={open} ariaLabel="AI 修改候选" width={560} onClose={() => setOpen(false)}><div className="creation-dialog">
      <div className="creation-section-heading"><h2><Sparkles size={17} />AI 修改候选</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={() => setOpen(false)}><X size={16} /></Button></div>
      <div className="creation-selected-comments my-scrollbar">{selectedIds.map((id) => { const comment = view.comments.find((entry) => entry.commentId === id); return comment ? <p key={id}>{comment.body}</p> : null })}</div>
      <label className="creation-form-grid">补充要求<textarea className="my-input" rows={3} value={instruction} maxLength={1000} disabled={busy} onChange={(event) => setInstruction(event.target.value)} /></label>
      {validPlan && <div className="creation-plan" role="status"><p>预计输入 <strong>{validPlan.value.estimatedTokens.toLocaleString()}</strong> tokens（估算）</p><p className="creation-meta">源片段 {validPlan.value.inputBytes.toLocaleString()} / {validPlan.value.maxInputBytes.toLocaleString()} 字节 · {validPlan.value.fragmentCount} 个片段 · {validPlan.value.selectedCount} 条批注</p>
        <p className="creation-meta">{validPlan.value.model ?? '尚未配置模型'}</p>
        {!validPlan.value.available && <Button size="sm" onClick={() => useApp.getState().setPage('settings')}><Settings size={14} />前往设置</Button>}
      </div>}
      {error && <div className="creation-error" role="alert"><span className="creation-grow">{error.error}</span>{unknown && <Button size="sm" disabled={busy} onClick={() => void recover()}>核对原操作</Button>}
        {/MODEL|CONFIG|PROVIDER/.test(error.code) && <Button size="sm" onClick={() => useApp.getState().setPage('settings')}><Settings size={14} />设置</Button>}</div>}
      <div className="creation-dialog-footer">{phase === 'generating' || phase === 'cancelling' ? <><span className="creation-meta" role="status"><Loader2 size={14} className="creation-spinner" />{phase === 'cancelling' ? '正在停止…' : '正在生成候选…'}</span><Button disabled={phase === 'cancelling'} onClick={() => void cancel()}><Square size={13} />停止生成</Button></>
        : <><Button disabled={busy || unknown || dirty || selectedIds.length === 0 || selectedIds.length > 8} onClick={() => void estimate()}>{phase === 'planning' && <Loader2 size={14} className="creation-spinner" />}估算用量</Button><Button variant="primary" disabled={busy || unknown || !validPlan?.value.available || dirty || commands.busy || commands.recoveryRequired} onClick={() => void generate()}><Sparkles size={15} />生成候选</Button></>}
      </div>
    </div></Modal>
  </>
}
