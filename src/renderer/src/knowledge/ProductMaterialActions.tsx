import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { CheckCircle2, FileText, Loader2, Send, ShieldAlert } from 'lucide-react'
import { Button } from '../my/ui'
import { Select } from '../components/Select'
import { useApp } from '../store'
import { api } from '../api'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, onKnowledgeScope, requireKnowledge, useKnowledgeOwner } from './bridge'
import { projectRootKey } from '../my/navigation'
import type { KnowledgeArtifact, KnowledgeCollection, KnowledgePublication, KnowledgeSource } from '../../../shared/knowledge-access'

function PublicationPreview({ item, onConfirm, disabled, readOnly = false }: { item: KnowledgePublication; onConfirm: () => void; disabled: boolean; readOnly?: boolean }): JSX.Element {
  return <section className="space-y-2 rounded-my-md border border-my-line-warning bg-my-warning-subtle p-3"><div className="flex items-center gap-2"><ShieldAlert size={14} className="text-my-warning-text" /><strong className="text-my-sm">发布预览</strong><span className="ml-auto text-my-2xs text-my-warning-text">{item.state}</span></div><p className="break-all text-my-xs text-my-tertiary">目标：{item.collectionName} · {item.collectionId} · {item.scope.instanceId || '实例未知'}</p><p className="text-my-sm font-medium">标题：{item.title}</p><pre className="my-scrollbar max-h-48 overflow-auto whitespace-pre-wrap rounded-my-md border border-my-line bg-my-layer-1 p-3 font-mono text-my-xs leading-5">{item.body}</pre><p className="text-my-2xs leading-relaxed text-my-warning-text">只会发送上述预览标题及正文；内容、目标或版本改变后必须重新预览。超时/无回执保持不确定，不会自动重发。</p>{!readOnly && item.state === 'previewed' && <Button size="sm" variant="primary" disabled={disabled} onClick={onConfirm}><Send size={12} />明确发布</Button>}{item.state === 'published' && <p role="status" className="flex items-center gap-1 text-my-xs text-my-success-text"><CheckCircle2 size={13} />已确认远端文档：{item.remoteDocumentId || '未提供'}；索引状态：尚未确认</p>}{item.state === 'uncertain' && <p role="alert" className="text-my-xs text-my-warning-text">远端结果不确定，请先在 WeKnora 侧核验；不要为了重试而另建预览。</p>}<p className="text-my-xs text-my-secondary">{item.detail}</p></section>
}

export interface ProductMaterialDraftSeed {
  id: string
  root: string
  title: string
  body: string
  sessionId: string
  turnId?: string
  sourceIds?: readonly string[]
}

export function ProductMaterialActions({ root, sessionId, sources, draftSeed, allowCreate = true }: { root: string; sessionId?: string; sources: KnowledgeSource[]; draftSeed?: ProductMaterialDraftSeed | null; allowCreate?: boolean }): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const snapshot = useApp((state) => state.snapshot)
  const tasks = snapshot?.tasks ?? []
  const [items, setItems] = useState<KnowledgeArtifact[]>([])
  const [selected, setSelected] = useState<KnowledgeArtifact | null>(null)
  const [editing, setEditing] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [originTurnId, setOriginTurnId] = useState('')
  const appliedSeed = useRef<string | null>(null)
  const sourceSelectionEdited = useRef(false)
  const [collections, setCollections] = useState<KnowledgeCollection[]>([])
  const [collectionId, setCollectionId] = useState('')
  const [taskDir, setTaskDir] = useState('')
  const [publication, setPublication] = useState<KnowledgePublication | null>(null)
  const [receipts, setReceipts] = useState<KnowledgePublication[]>([])
  const [inspectedReceiptId, setInspectedReceiptId] = useState<string | null>(null)
  const [receiptCursor, setReceiptCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const receiptSequence = useRef(0)
  const [handoffPreview, setHandoffPreview] = useState<{ taskDir: string; revision: string | null; body: string } | null>(null)
  const [resolution, setResolution] = useState<{ requestId: string; outcome: 'verified_absent' | 'verified_published'; remoteId: string; acknowledged: boolean } | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [publicationError, setPublicationError] = useState('')
  const [targetError, setTargetError] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef<symbol | null>(null)
  const bridge = knowledgeBridge(['saveArtifact'])
  const publicationBridge = knowledgeBridge(['publicationPage', 'previewPublication', 'confirmPublication'])
  const publicationUnavailable = !publicationBridge ? knowledgeUnavailableFor('知识发布') : ''
  useEffect(() => { setItems([]); setReceipts([]); setInspectedReceiptId(null); setReceiptCursor(null); setLoadingEarlier(false); receiptSequence.current++; setSelected(null); setEditing(false); setPublication(null); setHandoffPreview(null); setResolution(null); setCollections([]); setCollectionId(''); setSourceIds([]); setOriginTurnId(''); appliedSeed.current = null; sourceSelectionEdited.current = false; setStatus(''); setError(''); setPublicationError(''); setTargetError(''); setBusy(false); running.current = null }, [owner.current])
  const load = useCallback(async (): Promise<void> => {
    if (!owner.current() || !canInteract()) return
    const token = ++receiptSequence.current
    setLoadingEarlier(false)
    const current = (): boolean => owner.current() && token === receiptSequence.current
    await Promise.all([
      (async () => {
        const reader = knowledgeBridge(['artifacts'])
        if (!reader) { if (current()) setError(knowledgeUnavailableFor('项目材料列表')); return }
        try { const artifacts = requireKnowledge(await reader.artifacts(owner.input)); if (current()) setItems(artifacts) }
        catch (failure) { if (current()) setError(knowledgeError(failure, '项目材料列表')) }
      })(),
      (async () => {
        const history = knowledgeBridge(['publicationPage'])
        if (!history) { if (current()) setPublicationError(knowledgeUnavailableFor('发布记录')); return }
        try {
          const publications = requireKnowledge(await history.publicationPage(owner.input))
          if (!current()) return
          setReceipts((old) => [...publications.items, ...old.filter((item) => !publications.items.some((next) => next.requestId === item.requestId))]); setReceiptCursor(publications.nextCursor); setPublicationError('')
        } catch (failure) { if (current()) setPublicationError(knowledgeError(failure, '发布记录')) }
      })(),
      (async () => {
        const targetsBridge = knowledgeBridge(['context', 'collections'])
        if (!targetsBridge) { if (current()) setTargetError(knowledgeUnavailableFor('发布目标选择')); return }
        try {
          const context = requireKnowledge(await targetsBridge.context(owner.input))
          if (!current()) return
          if (!context.scope.connectionId || !context.scope.connectionRevision) { setCollections([]); setCollectionId(''); return }
          const result = requireKnowledge(await targetsBridge.collections({ ...owner.input, connectionId: context.scope.connectionId, connectionRevision: context.scope.connectionRevision }))
          if (!current()) return
          const targets = result.items.filter((item) => context.scope.collectionIds.includes(item.id))
          setCollections(targets); setCollectionId((old) => targets.some((item) => item.id === old) ? old : targets[0]?.id || ''); setTargetError('')
        } catch (failure) { if (current()) setTargetError(knowledgeError(failure, '发布目标选择')) }
      })()
    ])
  }, [owner.input, owner.current, canInteract])
  const loadEarlier = async (): Promise<void> => {
    const history = knowledgeBridge(['publicationPage'])
    if (!history || !receiptCursor || loadingEarlier || !owner.current() || !canInteract()) return
    const token = ++receiptSequence.current; const cursor = receiptCursor
    setLoadingEarlier(true)
    try {
      const page = requireKnowledge(await history.publicationPage({ ...owner.input, cursor }))
      if (!owner.current() || token !== receiptSequence.current) return
      if (page.nextCursor === cursor || (!page.items.length && page.nextCursor)) throw new Error('发布记录分页没有前进，请重新加载桌面应用后核对')
      setReceipts((current) => [...current.filter((old) => !page.items.some((item) => item.requestId === old.requestId)), ...page.items]); setReceiptCursor(page.nextCursor)
    } catch (failure) { if (owner.current() && token === receiptSequence.current) setPublicationError(knowledgeError(failure, '发布记录')) }
    finally { if (owner.current() && token === receiptSequence.current) setLoadingEarlier(false) }
  }
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const invalidate = (): void => { setPublication(null); setHandoffPreview(null); setCollections([]); setCollectionId(''); void load() }
    const offScope = onKnowledgeScope((changedRoot, changedSession) => { if (projectRootKey(changedRoot) === projectRootKey(root) && changedSession === sessionId) invalidate() })
    const offIntegration = typeof api?.integrations?.onChanged === 'function' ? api.integrations.onChanged(invalidate) : undefined
    return () => { offScope(); offIntegration?.() }
  }, [root, sessionId, load])
  const edit = (item?: KnowledgeArtifact): void => { setEditing(true); setSelected(item ?? null); setTitle(item?.title ?? '产品需求说明'); setBody(item?.body ?? '# 产品需求说明\n\n## 目标\n\n## 场景与规则\n\n## 验收与未决问题\n'); setSourceIds(item?.sourceIds ?? []); setOriginTurnId(item?.turnId ?? ''); sourceSelectionEdited.current = true; setReviewed(false); setHandoffPreview(null); setStatus(''); setError(''); setPublication(null) }
  useEffect(() => {
    if (!draftSeed || draftSeed.sessionId !== sessionId || projectRootKey(draftSeed.root) !== projectRootKey(root) || !owner.current()) return
    if (appliedSeed.current !== draftSeed.id) {
      appliedSeed.current = draftSeed.id; sourceSelectionEdited.current = false
      setEditing(true); setSelected(null); setTitle(draftSeed.title); setBody(draftSeed.body); setOriginTurnId(draftSeed.turnId ?? ''); setReviewed(false); setHandoffPreview(null); setPublication(null); setStatus('从这条回答起草，审阅后保存。'); setError('')
    }
    if (!sourceSelectionEdited.current) setSourceIds(sources.filter((source) => Boolean(draftSeed.turnId) && source.sessionId === sessionId && source.turnId === draftSeed.turnId && source.suppliedToAgent && (!draftSeed.sourceIds || draftSeed.sourceIds.includes(source.id))).map((source) => source.id))
  }, [draftSeed, root, sessionId, sources, owner.current])
  const availableSources = draftSeed && !selected ? sources.filter((source) => Boolean(originTurnId) && source.sessionId === sessionId && source.turnId === originTurnId && source.suppliedToAgent) : sources
  const changed = !selected || selected.title !== title.trim() || selected.body !== body || JSON.stringify(selected.sourceIds) !== JSON.stringify(sourceIds)
  const canUseSaved = selected && !changed
  const inspectedReceipt = receipts.find((item) => item.requestId === inspectedReceiptId)
  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    if (running.current || !owner.current() || !canInteract()) return
    const token = Symbol('knowledge-material-action')
    running.current = token; setBusy(true); setError('')
    try { await operation() } catch (failure) { if (owner.current()) setError(knowledgeError(failure)) }
    finally { if (running.current === token) { running.current = null; if (owner.current()) setBusy(false) } }
  }
  const save = async (): Promise<void> => {
    if (!bridge || !title.trim() || !body.trim() || !reviewed) return
    await mutate(async () => { const item = requireKnowledge(await bridge.saveArtifact({ ...owner.input, ...(originTurnId ? { turnId: originTurnId } : {}), id: selected?.id, expectedRevision: selected?.revision ?? null, title: title.trim(), body, kind: 'product-requirements', sourceIds })); if (owner.current()) { sourceSelectionEdited.current = true; setSelected(item); setReviewed(false); setPublication(null); setHandoffPreview(null); setStatus('已保存确认稿'); await load() } })
  }
  const handoff = async (): Promise<void> => {
    const handoffBridge = knowledgeBridge(['taskPrd'])
    if (!handoffBridge || !canUseSaved || !taskDir) return
    await mutate(async () => { const current = requireKnowledge(await handoffBridge.taskPrd({ ...owner.input, taskDir })); if (owner.current()) setHandoffPreview({ taskDir, revision: current.revision, body: current.body || body }) })
  }
  const confirmHandoff = async (): Promise<void> => {
    const handoffBridge = knowledgeBridge(['handoff'])
    if (!handoffBridge || !selected || !canUseSaved || !handoffPreview) return
    await mutate(async () => { const result = requireKnowledge(await handoffBridge.handoff({ ...owner.input, artifactId: selected.id, revision: selected.revision, taskDir: handoffPreview.taskDir, developerBody: handoffPreview.body, expectedPrdRevision: handoffPreview.revision })); if (owner.current()) { setStatus(`已关联开发任务 ${result.taskDir}`); setHandoffPreview(null) } })
  }
  const preview = async (): Promise<void> => {
    if (!publicationBridge || publicationError || !selected || !canUseSaved || !collectionId) return
    if (receipts.some((item) => item.artifactId === selected.id && item.artifactRevision === selected.revision && item.collectionId === collectionId && (item.state === 'uncertain' || item.state === 'pending'))) { setError('此版本在目标库有待核实的发布记录。先在远端核验，不允许盲目重发。'); return }
    await mutate(async () => { const item = requireKnowledge(await publicationBridge.previewPublication({ ...owner.input, artifactId: selected.id, revision: selected.revision, collectionId, requestId: crypto.randomUUID() })); if (owner.current()) { setPublication(item); await load() } })
  }
  const confirm = async (): Promise<void> => {
    if (!publicationBridge || !publication || !canUseSaved || publication.state !== 'previewed' || publication.collectionId !== collectionId) return
    await mutate(async () => { const item = requireKnowledge(await publicationBridge.confirmPublication({ ...owner.input, requestId: publication.requestId })); if (owner.current()) { setPublication(item); await load() } })
  }
  const resolvePublication = async (): Promise<void> => {
    const resolver = knowledgeBridge(['resolvePublication'])
    if (!resolver || !resolution || !resolution.acknowledged || (resolution.outcome === 'verified_published' && !resolution.remoteId.trim())) return
    await mutate(async () => { const resolved = requireKnowledge(await resolver.resolvePublication({ ...owner.input, requestId: resolution.requestId, outcome: resolution.outcome, acknowledgeDuplicateRisk: true, ...(resolution.outcome === 'verified_published' ? { remoteDocumentId: resolution.remoteId.trim() } : {}) })); if (owner.current()) { setReceipts((current) => current.map((item) => item.requestId === resolved.requestId ? resolved : item)); setResolution(null); setPublication(null); await load() } })
  }
  return <section className="space-y-3" aria-label="产品需求说明与人工发布">
    <div className="flex flex-wrap items-center gap-2"><FileText size={14} /><h3 className="text-my-sm font-semibold">产品需求说明</h3>{allowCreate && <Button size="sm" variant="outline" className="ml-auto" disabled={busy || !bridge} onClick={() => edit()}>新建说明</Button>}</div>
    <p className="text-my-xs leading-relaxed text-my-tertiary">{allowCreate ? '整理讨论结论，保存为项目需求说明。已保存的说明可交给开发任务，或预览后发布到知识库。' : '在会话中告诉 Agent 整理需求、发布知识或交给开发即可。这里可查看和维护已保存的材料。'}</p>
    {editing ? <div className="space-y-3">
      <label className="block text-my-xs text-my-secondary">说明标题<input aria-label="产品说明标题" className="my-input mt-1 w-full" disabled={busy} value={title} onChange={(event) => { setTitle(event.target.value); setReviewed(false); setPublication(null); setHandoffPreview(null) }} maxLength={200} /></label>
      <label className="block text-my-xs text-my-secondary">说明正文<textarea aria-label="产品说明正文" rows={10} style={{ minHeight: '12rem' }} className="my-input mt-1 w-full font-mono text-my-xs leading-5" disabled={busy} value={body} onChange={(event) => { setBody(event.target.value); setReviewed(false); setPublication(null); setHandoffPreview(null) }} /></label>
      {availableSources.length > 0 && <details className="text-my-xs"><summary className="cursor-pointer text-my-secondary">关联来源（{sourceIds.length}）</summary><fieldset className="space-y-2 rounded-my-md border border-my-line p-3"><legend className="px-1 text-my-xs text-my-secondary">关联实际来源（仅元数据，不自动加入正文）</legend>{availableSources.slice(0, 12).map((source) => <label key={source.id} className="flex items-start gap-2 text-my-xs"><input type="checkbox" disabled={busy} checked={sourceIds.includes(source.id)} onChange={(event) => { sourceSelectionEdited.current = true; setSourceIds(event.target.checked ? [...sourceIds, source.id] : sourceIds.filter((id) => id !== source.id)); setReviewed(false); setPublication(null) }} /><span>{source.title}</span></label>)}</fieldset></details>}
      <label className="flex items-start gap-2 text-my-xs text-my-secondary"><input type="checkbox" disabled={busy} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已审阅正文，保存为项目确认稿。</label>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="primary" disabled={busy || !bridge || !title.trim() || !body.trim() || !reviewed} onClick={() => void save()}>{busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}保存确认稿</Button><Button size="sm" disabled={busy} onClick={() => { setEditing(false); setPublication(null); setHandoffPreview(null) }}>关闭编辑</Button>{selected && <span className="break-all text-my-2xs text-my-tertiary">已保存 · {selected.relativePath}{changed ? ' · 有未保存修改' : ''}</span>}</div>
      {canUseSaved && <div className="space-y-3 border-t border-my-line pt-3">
        <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-my-xs text-my-secondary">选择开发任务<Select ariaLabel="选择开发任务" className="mt-1 w-full" value={taskDir} disabled={busy} onChange={(value) => { setTaskDir(value); setHandoffPreview(null) }} options={[{ value: '', label: '不交接' }, ...tasks.filter((task) => task.record?.status === 'planning').map((task) => ({ value: task.dirName, label: task.record?.title ?? task.dirName }))]} /></label><Button size="sm" variant="outline" disabled={busy || !taskDir || !knowledgeBridge(['taskPrd', 'handoff'])} onClick={() => void handoff()}>预览开发交接</Button></div>
        {handoffPreview && <section className="space-y-2 rounded-my-md border border-my-line p-3"><p className="break-words text-my-xs text-my-secondary">将关联到 {handoffPreview.taskDir}。开发 PRD 当前版本：{handoffPreview.revision?.slice(0, 12) || '尚不存在'}。已有正文默认保留，请在此完善开发范围；确认只保存 PRD 与来源关联，不启动实现或改变 Jira 状态。</p><textarea aria-label="开发 PRD 交接正文" className="my-input min-h-40 w-full font-mono text-my-xs leading-5" disabled={busy} value={handoffPreview.body} onChange={(event) => setHandoffPreview({ ...handoffPreview, body: event.target.value })} /><Button size="sm" variant="primary" disabled={busy || !handoffPreview.body.trim() || !knowledgeBridge(['handoff'])} onClick={() => void confirmHandoff()}>确认保存交接</Button></section>}
        <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-my-xs text-my-secondary">人工发布目标<Select ariaLabel="选择发布知识库" className="mt-1 w-full" value={collectionId} disabled={busy} onChange={(value) => { setCollectionId(value); setPublication(null) }} options={[{ value: '', label: '选择目标知识库' }, ...collections.map((item) => ({ value: item.id, label: `${item.name} · ${item.knowledgeCount} 篇` }))]} /></label><Button size="sm" variant="outline" disabled={busy || !collectionId || !publicationBridge || Boolean(publicationError)} onClick={() => void preview()}>预览发布内容</Button></div>
        {publication && <PublicationPreview item={publication} disabled={busy} onConfirm={() => void confirm()} />}
      </div>}
    </div> : <div className="space-y-1">{items.length === 0 && <p className="text-my-xs text-my-tertiary">{allowCreate ? '尚无已保存说明。' : '还没有需求说明；在会话中让 Agent 整理讨论即可。'}</p>}{items.slice(0, 12).map((item) => <button type="button" key={`${item.id}:${item.revision}`} className="flex w-full items-center gap-2 rounded-my-md border border-my-line bg-my-layer-1 px-3 py-2 text-left hover:bg-my-layer-2" onClick={() => edit(item)}><FileText size={13} /><span className="min-w-0 flex-1 truncate text-my-sm">{item.title}</span><span className="text-my-2xs text-my-tertiary">打开</span></button>)}</div>}
    {!bridge && <p role="status" className="text-my-xs text-my-warning-text">{knowledgeUnavailableFor('项目材料保存')}</p>}
    {(publicationError || targetError || publicationUnavailable) && <details className="text-my-xs text-my-warning-text"><summary className="cursor-pointer">发布功能暂不可用</summary><p role="status" className="mt-2">{publicationError || targetError || publicationUnavailable}</p></details>}
    <details className="text-my-xs text-my-tertiary"><summary className="cursor-pointer">保存位置与版本说明</summary><p className="mt-2 leading-relaxed">保存到项目 .trellis/notes，可能随仓库共享。产品说明与开发 PRD 分开；交接、发布仍需分别确认。外部修改会提示冲突，已有来源保留对应快照。</p></details>
    {receipts.length > 0 && <details className="space-y-2 text-my-xs"><summary className="cursor-pointer text-my-secondary">发布记录（{receipts.length}）</summary>{receipts.map((receipt) => <div key={receipt.requestId} className="space-y-1 rounded-my-md border border-my-line p-2"><p className="break-words">{receipt.title} → {receipt.collectionName} · {receipt.state}</p><p className="break-all text-my-tertiary">{receipt.detail}{receipt.remoteDocumentId ? ` · 远端文档 ${receipt.remoteDocumentId} · 索引状态尚未确认` : ''}</p><Button size="sm" variant="ghost" onClick={() => { if (owner.current() && canInteract()) setInspectedReceiptId(receipt.requestId) }}>查看精确发布预览</Button>{['pending', 'uncertain'].includes(receipt.state) && <div className="space-y-2"><p className="text-my-warning-text">请先核验远端结果；没有自动重试。</p><Button size="sm" disabled={busy || !knowledgeBridge(['resolvePublication'])} onClick={() => setResolution({ requestId: receipt.requestId, outcome: 'verified_published', remoteId: '', acknowledged: false })}>记录人工核验结果</Button></div>}</div>)}{receiptCursor && <Button size="sm" disabled={busy || loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? "读取更早发布记录…" : "加载更早发布记录"}</Button>}</details>}
    {inspectedReceipt && owner.current() && projectRootKey(inspectedReceipt.scope.root) === projectRootKey(root) && <section aria-label="历史发布精确预览"><PublicationPreview item={inspectedReceipt} disabled readOnly onConfirm={() => {}} /><Button size="sm" variant="ghost" onClick={() => setInspectedReceiptId(null)}>关闭历史发布预览</Button></section>}
    {resolution && <section aria-label="人工核验发布结果" className="space-y-2 rounded-my-md border border-my-line-warning p-3"><p className="text-my-xs text-my-secondary">请先到目标 WeKnora 实例核查此次发布；这里只记录你实际核验的结论，不会代替远端查询。</p><Select ariaLabel="远端核验结果" value={resolution.outcome} disabled={busy} onChange={(value) => setResolution({ ...resolution, outcome: value as 'verified_absent' | 'verified_published', acknowledged: false })} options={[{ value: 'verified_published', label: '已核验存在，记录远端文档 ID' }, { value: 'verified_absent', label: '已核验不存在，明确允许新的发布尝试' }]} />{resolution.outcome === 'verified_published' && <input className="my-input w-full" aria-label="已核实远端文档 ID" value={resolution.remoteId} onChange={(event) => setResolution({ ...resolution, remoteId: event.target.value })} />}<label className="flex items-start gap-2 text-my-xs text-my-warning-text"><input type="checkbox" disabled={busy} checked={resolution.acknowledged} onChange={(event) => setResolution({ ...resolution, acknowledged: event.target.checked })} />我已在正确的实例与知识库完成核验，理解错误结论可能造成重复发布；此操作不会自动重试。</label><div className="flex gap-2"><Button size="sm" disabled={busy || !resolution.acknowledged || (resolution.outcome === 'verified_published' && !resolution.remoteId.trim())} onClick={() => void resolvePublication()}>记录核验结论</Button><Button size="sm" variant="ghost" disabled={busy || !knowledgeBridge(['resolvePublication'])} onClick={() => setResolution(null)}>取消</Button></div></section>}
    {status && <p role="status" className="break-words text-my-xs text-my-success-text">{status}</p>}{error && <p role="alert" className="break-words text-my-xs text-my-danger-text">{error}</p>}
  </section>
}
