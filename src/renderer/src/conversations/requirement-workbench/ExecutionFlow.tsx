import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowRight, Check, CircleAlert, GitBranch, Loader2, RefreshCw, X } from 'lucide-react'
import { requirementExecutionPrepareSchema, type RequirementExecutionPreparation, type RequirementExecutionPrepare } from '@shared/conversation-requirement-execution'
import type { RequirementView } from '@shared/conversation-requirements'
import type { AcpSessionRecord } from '@shared/types'
import { workflowScopeIdentity, type ExecutionEvent } from '@shared/workflow'
import type { WorkflowApplicationEventPage } from '@shared/workflow-application'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { useMy } from '../../my/store'
import { useApp } from '../../store'
import { projectRootKey } from '../../my/navigation'
import { statusLabel } from '../../utils/labels'
import { DocumentSourceProvider } from '../../reader/document-source'
import { useInteractionGuard } from '../../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { openConversationSettings } from '../Conversation'
import { useConversations } from '../workspace'
import { useManagedWorkflow } from '../../acp/workflow/use-managed-workflow'
import { belongsToNode, recordOf } from '../../acp/workflow/model'
import { SessionDetails } from '../../acp/SessionDetails'
import './execution.css'

const WorkflowPanel = lazy(() => import('../../acp/workflow/WorkflowPanel').then(module => ({ default: module.WorkflowPanel })))
const commandsPrefix = 'tpanel.requirement-execution.v1.'

export function RequirementExecutionFlow({ entryKey, draftId, preferredAgentId, onClose }: { entryKey: string; draftId: string; preferredAgentId?: string; onClose(): void }): JSX.Element {
  const entry = useConversations(state => state.entries[entryKey]), runtimes = useConversations(state => state.runtimes)
  const canInteract = useInteractionGuard()
  const [view, setView] = useState<RequirementView>(), [result, setResult] = useState<RequirementExecutionPreparation>()
  const [command, setCommand] = useState<RequirementExecutionPrepare>(), [agentId, setAgentId] = useState(preferredAgentId ?? entry?.runtimeId ?? '')
  const [pending, setPending] = useState('read'), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const [classification, setClassification] = useState<'' | 'lightweight' | 'complex'>('')
  const [planningEditor, setPlanningEditor] = useState<{ file: 'design.md' | 'implement.md'; text: string; base: string | null }>()
  const request = useRef(0), mounted = useRef(true), held = useRef(false), readyReads = useRef(0)
  const identity = JSON.stringify([entryKey, entry?.owner, entry?.conversation?.id, entry?.conversation?.creatorId, entry?.conversation?.workspace.root, draftId])
  const current = useRef(identity); current.current = identity
  const conversationId = entry?.conversation?.id
  const storageKey = `${commandsPrefix}${encodeURIComponent(entry?.conversation?.creatorId ?? '')}.${conversationId}.${draftId}`
  const planningKey = (file: string): string => `${storageKey}.planning.${file}`
  const valid = (source: string, ticket: number): boolean => mounted.current && current.current === source && ticket === request.current && canInteract() && isPrivateEntrySelected(entryKey)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  useEffect(() => {
    const ticket = ++request.current, source = identity, client = conversationClient()
    if (!conversationId || !client) { setError('原需求当前不可读取。'); setPending(''); return }
    setPending('read'); setError('')
    void client.requirements.read(conversationId, draftId).then(reply => {
      const incoming = conversationValue(reply)
      if (!valid(source, ticket)) return
      if (incoming.draft.conversationId !== conversationId || incoming.draft.id !== draftId || incoming.draft.creatorId !== entry?.conversation?.creatorId) throw new Error('需求来源已变化，请返回原需求。')
      if (incoming.draft.handoff?.state !== 'created' || !incoming.draft.handoff.task || !incoming.draft.handoff.planRevision) throw new Error('请先完成需求与独立计划的交接。')
      setView(incoming)
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const previous = requirementExecutionPrepareSchema.parse(JSON.parse(stored))
        if (previous.expectedHandoffCommandId !== incoming.draft.handoff.commandId || previous.expectedPlanRevision !== incoming.draft.handoff.planRevision) throw new Error('原执行准备属于另一固定版本，已保留原请求。')
        setCommand(previous); setAgentId(previous.agentId)
      }
    }).catch(cause => { if (valid(source, ticket)) setError(conversationError(cause)) }).finally(() => { if (valid(source, ticket)) setPending('') })
    return () => { request.current++ }
  }, [identity, attempt])
  const available = runtimes.filter(runtime => runtime.enabled && runtime.available)
  useEffect(() => { if (!command && !preferredAgentId && !available.some(runtime => runtime.id === agentId)) setAgentId(available[0]?.id ?? '') }, [runtimes, command, agentId, preferredAgentId])
  const prepare = async (observing = false, reviewedDigest?: string): Promise<void> => {
    const client = conversationClient(), receipt = view?.draft.handoff
    if (held.current || pending || !client || !conversationId || !receipt?.planRevision || !canInteract() || !isPrivateEntrySelected(entryKey)) return
    const source = identity, ticket = ++request.current
    if (!observing) readyReads.current = 0
    held.current = true; setPending('prepare'); setError('')
    try {
      const previous = command ?? requirementExecutionPrepareSchema.parse({ commandId: crypto.randomUUID(), expectedHandoffCommandId: receipt.commandId, expectedPlanRevision: receipt.planRevision, agentId })
      const input = reviewedDigest ? requirementExecutionPrepareSchema.parse({ ...previous, reviewDigest: reviewedDigest, reviewClassification: classification || undefined }) : previous
      if (!command) {
        let count = 0
        for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(commandsPrefix) && !key.includes('.planning.')) count++ }
        if (count >= 64 && localStorage.getItem(storageKey) === null) throw new Error('待核对执行准备已达上限，请先检查原准备记录。')
        localStorage.setItem(storageKey, JSON.stringify(input)); setCommand(input)
      }
      if (reviewedDigest) { localStorage.setItem(storageKey, JSON.stringify(input)); setCommand(input) }
      const prepared = conversationValue(await client.requirements.prepareExecution(conversationId, draftId, input))
      if (!valid(source, ticket)) return
      if (prepared.commandId !== input.commandId || prepared.task.taskId !== receipt.task?.taskId || projectRootKey(prepared.task.root) !== projectRootKey(receipt.task?.root)) throw new Error('执行准备回执不是原任务，未进入其他工程。')
      if (prepared.state === 'review-required' && input.reviewDigest) {
        const { reviewDigest: _reviewDigest, reviewClassification: _reviewClassification, ...unreviewed } = input
        localStorage.setItem(storageKey, JSON.stringify(unreviewed)); setCommand(unreviewed)
      }
      if (prepared.state === 'prepared' && (!prepared.existing && !prepared.activation.verified || !prepared.origin || !prepared.session || !prepared.snapshot || prepared.origin.sessionId !== prepared.session.sessionId || prepared.origin.connectionGeneration !== prepared.session.connectionGeneration || prepared.session.privateConversation || projectRootKey(prepared.snapshot.meta.root) !== projectRootKey(receipt.task?.root))) throw new Error('原执行会话或任务激活尚未核对完成。')
      setResult(prepared)
      if (prepared.snapshot) useApp.getState().setSnapshot(prepared.snapshot)
    } catch (cause) { if (valid(source, ticket)) setError(conversationError(cause)) }
    finally { held.current = false; if (valid(source, ticket)) setPending('') }
  }
  useEffect(() => {
    if (pending || result?.state !== 'preparing' || !result.session || readyReads.current >= 20) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (document.hidden || held.current || readyReads.current >= 20) return
      timer = setTimeout(() => { readyReads.current++; void prepare(true) }, 1500)
    }
    const visible = (): void => { if (!document.hidden && !timer) schedule() }
    schedule(); document.addEventListener('visibilitychange', visible)
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [result, pending, identity])
  const mayChangeEngine = Boolean(command && (result?.state === 'review-required' || result?.state === 'not-admitted' && result.retryable))
  const missingPlanning = result?.review ? (['design.md', 'implement.md'] as const).filter(name => !result.review?.files.some(file => file.path === `.trellis/tasks/${result.task.taskDir}/${name}` && file.text.trim())) : []
  const releaseUnadmitted = (): void => {
    if (!mayChangeEngine || pending || !canInteract() || !isPrivateEntrySelected(entryKey)) return
    localStorage.removeItem(storageKey); setCommand(undefined); setResult(undefined); setClassification(''); setError('')
  }
  const openPlanningEditor = (file: 'design.md' | 'implement.md'): void => {
    if (!result?.review || result.task.status !== 'planning' || pending) return
    const actual = result.review.files.find(item => item.path === `.trellis/tasks/${result.task.taskDir}/${file}`)
    let next = { file, text: actual?.text ?? '', base: actual?.digest ?? null }
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(planningKey(file)) ?? 'null')
      if (saved && typeof saved === 'object' && 'text' in saved && 'base' in saved && typeof saved.text === 'string' && (saved.base === null || typeof saved.base === 'string')) next = { file, text: saved.text, base: saved.base }
    } catch { setError('本地规划草稿不可读取，现有任务文件未改变。') }
    setPlanningEditor(next)
  }
  const savePlanningEditor = async (): Promise<void> => {
    const client = conversationClient(), editor = planningEditor, review = result?.review, receipt = view?.draft.handoff
    if (!client || !conversationId || !command || !editor || !review || !receipt?.task || pending || held.current || !canInteract() || !isPrivateEntrySelected(entryKey)) return
    const actual = review.files.find(item => item.path === `.trellis/tasks/${result.task.taskDir}/${editor.file}`)
    if ((actual?.digest ?? null) !== editor.base) { setError('原规划文件已变化；旧草稿保留，请先比较或复制。'); return }
    const source = identity, ticket = ++request.current; held.current = true; setPending('planning'); setError('')
    try {
      const input = requirementExecutionPrepareSchema.parse({ ...command, reviewDigest: review.digest, reviewClassification: undefined, planningWrite: { file: editor.file, body: editor.text, expectedDigest: editor.base } })
      const saved = conversationValue(await client.requirements.prepareExecution(conversationId, draftId, input))
      if (!valid(source, ticket)) return
      if (saved.commandId !== command.commandId || saved.state !== 'review-required' || !saved.review || saved.task.taskId !== receipt.task.taskId || projectRootKey(saved.task.root) !== projectRootKey(receipt.task.root)) throw new Error('规划保存回执与原任务不一致，请核对原文件。')
      localStorage.removeItem(planningKey(editor.file)); setPlanningEditor(undefined); setResult(saved)
    } catch (cause) { if (valid(source, ticket)) setError(conversationError(cause)) }
    finally { held.current = false; if (valid(source, ticket)) setPending('') }
  }
  return <Modal open onClose={onClose} width={960} ariaLabel="Trellis 执行流程" placement="center"><section className="requirement-execution my-scrollbar">
    <header className="requirement-execution-header"><GitBranch size={17} aria-hidden="true" /><h2 className="my-item-title">Trellis 执行流程</h2><Button variant="ghost" size="sm" aria-label="关闭执行流程" onClick={onClose}><X size={15} /></Button></header>
    <div className="requirement-execution-body">
      {pending === 'read' && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在核对固定材料…</p>}
      {view?.draft.handoff?.task && <><h3 className="my-item-title">{view.draft.handoff.task.title}</h3><p className="my-item-description break-all">{view.draft.handoff.task.root}</p><div className="requirement-execution-inputs"><span className="my-item-description"><Check size={13} />已确认需求</span><span className="my-item-description"><Check size={13} />独立计划</span><span className="my-item-description"><Check size={13} />固定来源</span></div></>}
      {error && <div className="requirement-workbench-feedback" role="alert"><CircleAlert size={14} /><span className="my-item-title">执行准备未完成</span><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => view ? void prepare() : setAttempt(value => value + 1)}>检查原准备</Button><details><summary className="my-item-description">原因</summary><pre>{error}</pre></details></div>}
      {result?.state === 'prepared' && result.session && result.origin && result.snapshot ? <PreparedWorkflow entryKey={entryKey} result={result} session={result.session} origin={result.origin} onClose={onClose} /> : view && <>
        <label className="requirement-execution-engine"><span className="my-item-title">执行引擎</span>{command ? <span className="my-item-description">{runtimes.find(runtime => runtime.id === command.agentId)?.name ?? command.agentId}</span> : <select className="my-input" value={agentId} disabled={Boolean(pending)} onChange={event => setAgentId(event.target.value)} aria-label="Trellis 执行引擎">{agentId && !available.some(runtime => runtime.id === agentId) && <option value={agentId} disabled>{runtimes.find(runtime => runtime.id === agentId)?.name ?? agentId}（不可用）</option>}{available.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}</select>}</label>
        {!command && agentId && !available.some(runtime => runtime.id === agentId) && <p className="my-item-description" role="status">原选择的引擎不可用，请选择当前可用的引擎。</p>}
        {mayChangeEngine && <Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={releaseUnadmitted}>更换执行引擎</Button>}
        {!command && !available.length && <div className="requirement-workbench-line"><span className="my-item-description">未找到可用执行引擎</span><Button size="sm" variant="ghost" onClick={() => { onClose(); openConversationSettings() }}>打开引擎设置</Button></div>}
        {result?.detail && (result.state === 'review-required'
          ? <p className="my-item-description" role="status">{result.detail}</p>
          : <div className="requirement-execution-state"><span className="my-item-title">{result.state === 'preparing' ? '原会话准备中' : result.state === 'uncertain' ? '原准备待核对' : '原准备未完成'}</span><details><summary className="my-item-description">详情</summary><pre>{result.detail}</pre></details></div>)}
        {result?.session && <Button size="sm" variant="outline" onClick={() => {
          const session = result.session
          if (!session || !canInteract() || projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(result.task.root)) return
          useMy.setState({ taskConversationTarget: null, agentSessionTarget: session.sessionId }); onClose(); useApp.getState().setPage('acp')
        }}>打开原执行会话</Button>}
        {result?.state === 'review-required' && result.review ? <section className="requirement-execution-review">
          <h3 className="my-item-title">审阅目标工程规划材料</h3>
          <p className="my-item-description">请检查目标工程的规划规则及下列全部材料，确认任务已满足其中适用的材料和评审要求。材料变化后需要重新审阅。</p>
          {result.review.files.map(file => <details key={file.path}><summary>{file.path} · {file.digest}</summary><pre>{file.text}</pre></details>)}
          {result.task.status === 'planning' && <div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => openPlanningEditor('design.md')}>编辑设计方案</Button><Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => openPlanningEditor('implement.md')}>编辑实施材料</Button></div>}
          {planningEditor && <div className="requirement-execution-review"><label className="my-item-title" htmlFor="requirement-planning-editor">{planningEditor.file}</label><textarea id="requirement-planning-editor" className="my-input" rows={12} maxLength={200_000} value={planningEditor.text} disabled={Boolean(pending)} onChange={event => {
            const next = { ...planningEditor, text: event.target.value }; setPlanningEditor(next)
            try { localStorage.setItem(planningKey(next.file), JSON.stringify({ text: next.text, base: next.base })) } catch { setError('本地规划草稿暂无法保存；请保持窗口打开并检查存储。') }
          }} />{(result.review.files.find(file => file.path === `.trellis/tasks/${result.task.taskDir}/${planningEditor.file}`)?.digest ?? null) !== planningEditor.base && <div role="alert"><p className="my-item-description">原文件已变化；旧草稿保留在这里，请先复制或比较。</p><Button size="sm" variant="outline" onClick={() => { const actual = result.review?.files.find(file => file.path === `.trellis/tasks/${result.task.taskDir}/${planningEditor.file}`); localStorage.removeItem(planningKey(planningEditor.file)); setPlanningEditor({ file: planningEditor.file, text: actual?.text ?? '', base: actual?.digest ?? null }) }}>放弃旧草稿并读取现文件</Button></div>}<div className="requirement-workbench-line"><Button size="sm" variant="primary" disabled={Boolean(pending) || (result.review.files.find(file => file.path === `.trellis/tasks/${result.task.taskDir}/${planningEditor.file}`)?.digest ?? null) !== planningEditor.base} onClick={() => void savePlanningEditor()}>{pending === 'planning' ? '保存中…' : '保存规划材料'}</Button><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => setPlanningEditor(undefined)}>收起编辑器</Button></div></div>}
          <label className="requirement-execution-engine"><span className="my-item-title">按目标工程规则选择任务类型</span><select className="my-input" value={classification} onChange={event => setClassification(event.target.value as '' | 'lightweight' | 'complex')}><option value="">请选择</option><option value="lightweight">轻量任务</option><option value="complex">复杂任务</option></select></label>
          {classification === 'complex' && missingPlanning.length > 0 && <p className="my-item-description" role="status">复杂任务还需补齐：{missingPlanning.join('、')}。请使用上方编辑入口保存后重新审阅。</p>}
          <Button size="sm" variant="primary" disabled={Boolean(pending) || !classification || Boolean(planningEditor) || classification === 'complex' && missingPlanning.length > 0} onClick={() => void prepare(false, result.review?.digest)}>已审阅并确认，准备执行</Button>
        </section> : <div className="requirement-workbench-line"><Button size="sm" variant="primary" disabled={Boolean(pending) || !command && !available.some(runtime => runtime.id === agentId)} onClick={() => void prepare()}>{pending === 'prepare' ? <Loader2 size={14} className="animate-spin" /> : command ? <RefreshCw size={14} /> : <ArrowRight size={14} />}{command ? '核对原执行准备' : '读取规划材料'}</Button><span className="my-item-description">审阅后准备执行，再预览并确认工作流。</span></div>}
      </>}
    </div>
  </section></Modal>
}

function PreparedWorkflow({ entryKey, result, session: metadata, origin, onClose }: { entryKey: string; result: RequirementExecutionPreparation; session: NonNullable<RequirementExecutionPreparation['session']>; origin: NonNullable<RequirementExecutionPreparation['origin']>; onClose(): void }): JSX.Element {
  const [session, setSession] = useState<AcpSessionRecord>(() => ({ ...metadata, events: [] }))
  const controller = useManagedWorkflow({ root: result.task.root, taskDir: result.task.taskDir, sessionId: origin.sessionId, generation: origin.connectionGeneration, enabled: true })
  const canInteract = useInteractionGuard()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = (): boolean => mounted.current && canInteract() && isPrivateEntrySelected(entryKey) && projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(result.task.root) && session.sessionId === origin.sessionId && session.connectionGeneration === origin.connectionGeneration
  return <DocumentSourceProvider client={null}><div className="requirement-execution-workflow"><div className="requirement-execution-state" role="status"><Check size={14} /><span className="my-item-title">原任务工作流</span><span className="my-item-description">任务{statusLabel(result.task.status)} · 会话{statusLabel(session.status)}</span></div>
    <RequirementWorkflowFailure entryKey={entryKey} result={result} controller={controller} onClose={onClose} />
    <details className="requirement-execution-review"><summary>发起会话的模型与模式</summary><p className="my-item-description">以下选择只作用于当前发起会话；托管阶段使用独立会话，不会继承这里的临时选择。可用选项和生效状态由执行引擎确认。</p><SessionDetails controlsOnly session={session} isCurrent={isCurrent} onUpdated={next => { if (isCurrent() && next.sessionId === origin.sessionId && next.connectionGeneration === origin.connectionGeneration && projectRootKey(next.projectRoot) === projectRootKey(result.task.root)) setSession(next) }} /></details>
    {controller.available ? <Suspense fallback={<p className="my-activity-note">正在打开工作流…</p>}><WorkflowPanel root={result.task.root} taskDir={result.task.taskDir} session={session} controller={controller} onOpenHistory={sessionId => {
      if (!canInteract() || projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(result.task.root)) return
      useMy.setState({ taskConversationTarget: null, agentSessionTarget: sessionId }); onClose(); useApp.getState().setPage('acp')
    }} /></Suspense> : <p className="my-item-description" role="alert">工作流接口当前不可用，请检查后台连接。</p>}
    {controller.error && <details><summary className="my-item-description">工作流读取详情</summary><pre>{controller.error}</pre></details>}
  </div></DocumentSourceProvider>
}

/** Read the exact failed stage's durable events without starting or resending work. */
function RequirementWorkflowFailure({ entryKey, result, controller, onClose }: { entryKey: string; result: RequirementExecutionPreparation; controller: ReturnType<typeof useManagedWorkflow>; onClose(): void }): JSX.Element | null {
  const canInteract = useInteractionGuard(), snapshot = controller.snapshot, head = snapshot?.snapshot?.run
  const node = head?.state === 'failed' ? snapshot?.nodes.find(value => value.state === 'failed' && value.run?.runId === head.run.runId && value.run.revision === head.run.revision) : undefined
  const key = JSON.stringify([controller.key, node?.nodeId, node?.run]), active = useRef(key); active.current = key
  const [attempt, setAttempt] = useState(0)
  const [details, setDetails] = useState<{ key: string; loading: boolean; error: string; incomplete: boolean; invalid?: ExecutionEvent; final?: ExecutionEvent }>({ key: '', loading: false, error: '', incomplete: false })
  useEffect(() => {
    if (!node?.run || !snapshot || typeof api.managedWorkflow?.events !== 'function') return
    let live = true
    const run = node.run, nodeId = node.nodeId, scope = workflowScopeIdentity(snapshot.scope), captured = key
    const current = (): boolean => live && active.current === captured && canInteract() && isPrivateEntrySelected(entryKey)
    setDetails({ key: captured, loading: true, error: '', incomplete: false })
    void (async () => {
      let cursor: WorkflowApplicationEventPage['cursor'] | null = null, invalid: ExecutionEvent | undefined, final: ExecutionEvent | undefined
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const response = await api.managedWorkflow.events(result.task.root, { taskDir: result.task.taskDir, run, cursor, limit: 100 })
        if (!current()) return
        if (!response.ok) throw new Error(response.error)
        if (response.value.resetRequired) throw new Error('记录游标已变化，请重新读取原阶段记录。')
        for (const { event } of response.value.items) {
          if (event.source !== 'platform' || event.attribution.kind !== 'assigned' || workflowScopeIdentity(event.attribution.scope) !== scope || !belongsToNode(event, nodeId, run)) continue
          if (event.type === 'workflow.output-invalid') invalid = event
          if (event.type === 'workflow.driver-result') final = event
        }
        cursor = response.value.cursor
        if (!response.value.hasMore || pageIndex === 49) { setDetails({ key: captured, loading: false, error: '', incomplete: response.value.hasMore, invalid, final }); return }
      }
    })().catch(error => { if (current()) setDetails({ key: captured, loading: false, error: error instanceof Error ? error.message : '无法读取原阶段记录', incomplete: false }) })
    return () => { live = false }
  }, [key, attempt, entryKey, result.task.root, result.task.taskDir, node?.nodeId, node?.run?.runId, node?.run?.revision])
  if (!node?.run) return null
  const currentDetails = details.key === key ? details : undefined, invalid = recordOf(currentDetails?.invalid?.payload), final = recordOf(currentDetails?.final?.payload)
  const reason = typeof invalid.reason === 'string' ? invalid.reason : undefined
  const outputPath = typeof invalid.outputPath === 'string' ? invalid.outputPath : undefined
  const exhausted = final.status === 'failed' && final.reason === 'Bounded output repair was exhausted; native side effects may already exist'
  const noRepair = final.status === 'failed' && final.reason === 'Required output version is unavailable; native side effects may already exist; no further repair prompt was sent'
  const current = (): boolean => canInteract() && isPrivateEntrySelected(entryKey) && projectRootKey(useApp.getState().snapshot?.meta.root) === projectRootKey(result.task.root)
  return <section className="requirement-execution-review" aria-label="工作流失败原因" role="status">
    <span className="my-item-title">{snapshot?.graph?.nodes.find(value => value.nodeId === node.nodeId)?.label ?? '原阶段'}未通过</span>
    {currentDetails?.loading ? <p className="my-item-description">正在读取原阶段记录…</p> : currentDetails?.error ? <p className="my-item-description">原阶段记录读取失败：{currentDetails.error}</p> : reason ? <><p className="my-item-description">{reason === 'MATERIAL_UNAVAILABLE' ? '必需产物未取得稳定、可读的版本；记录不能区分文件缺失、不可读取或内容无法归档。' : `产物核验记录：${reason}`}</p>{outputPath && <p className="my-item-description break-all">记录的产物路径：{outputPath}</p>}{exhausted && <p className="my-item-description">原运行的有限修复已结束，工程可能已有改动；请先核对，不会自动重跑。</p>}{noRepair && <p className="my-item-description">未追加自动修复请求；工程可能已有改动，请先核对原任务。</p>}</> : <p className="my-item-description">当前已读取记录未提供产物失败原因；请检查原阶段记录。</p>}
    {currentDetails?.incomplete && <p className="my-item-description">记录超过本次读取范围，原因可能不完整。</p>}
    <div className="requirement-workbench-line"><Button size="sm" variant="outline" disabled={Boolean(currentDetails?.loading)} onClick={() => setAttempt(value => value + 1)}>重新读取原因</Button><Button size="sm" variant="outline" onClick={() => { if (!current()) return; useApp.getState().expandTaskWorkspace({ fromPage: 'chat', taskDir: result.task.taskDir, archived: false, scrollTop: 0 }, `.trellis/tasks/${result.task.taskDir}/prd.md`); onClose() }}>核对原任务材料</Button>{node.sessionId && <Button size="sm" variant="outline" onClick={() => { if (!current() || !node.sessionId) return; useMy.setState({ taskConversationTarget: null, agentSessionTarget: node.sessionId }); onClose(); useApp.getState().setPage('acp') }}>打开原阶段会话</Button>}</div>
  </section>
}
