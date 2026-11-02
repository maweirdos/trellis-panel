import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowRight, Check, CircleAlert, GitBranch, Loader2, RefreshCw, X } from 'lucide-react'
import { requirementExecutionPrepareSchema, type RequirementExecutionPreparation, type RequirementExecutionPrepare } from '@shared/conversation-requirement-execution'
import type { RequirementView } from '@shared/conversation-requirements'
import type { AcpSessionRecord } from '@shared/types'
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
import './execution.css'

const WorkflowPanel = lazy(() => import('../../acp/workflow/WorkflowPanel').then(module => ({ default: module.WorkflowPanel })))
const commandsPrefix = 'tpanel.requirement-execution.v1.'

export function RequirementExecutionFlow({ entryKey, draftId, onClose }: { entryKey: string; draftId: string; onClose(): void }): JSX.Element {
  const entry = useConversations(state => state.entries[entryKey]), runtimes = useConversations(state => state.runtimes)
  const canInteract = useInteractionGuard()
  const [view, setView] = useState<RequirementView>(), [result, setResult] = useState<RequirementExecutionPreparation>()
  const [command, setCommand] = useState<RequirementExecutionPrepare>(), [agentId, setAgentId] = useState(entry?.runtimeId ?? '')
  const [pending, setPending] = useState('read'), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const request = useRef(0), mounted = useRef(true), held = useRef(false), readyReads = useRef(0)
  const identity = JSON.stringify([entryKey, entry?.owner, entry?.conversation?.id, entry?.conversation?.creatorId, entry?.conversation?.workspace.root, draftId])
  const current = useRef(identity); current.current = identity
  const conversationId = entry?.conversation?.id
  const storageKey = `${commandsPrefix}${encodeURIComponent(entry?.conversation?.creatorId ?? '')}.${conversationId}.${draftId}`
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
  useEffect(() => { if (!command && !available.some(runtime => runtime.id === agentId)) setAgentId(available[0]?.id ?? '') }, [runtimes, command, agentId])
  const prepare = async (observing = false): Promise<void> => {
    const client = conversationClient(), receipt = view?.draft.handoff
    if (held.current || pending || !client || !conversationId || !receipt?.planRevision || !canInteract() || !isPrivateEntrySelected(entryKey)) return
    const source = identity, ticket = ++request.current
    if (!observing) readyReads.current = 0
    held.current = true; setPending('prepare'); setError('')
    try {
      const input = command ?? requirementExecutionPrepareSchema.parse({ commandId: crypto.randomUUID(), expectedHandoffCommandId: receipt.commandId, expectedPlanRevision: receipt.planRevision, agentId })
      if (!command) {
        let count = 0
        for (let index = 0; index < localStorage.length; index++) if (localStorage.key(index)?.startsWith(commandsPrefix)) count++
        if (count >= 64 && localStorage.getItem(storageKey) === null) throw new Error('待核对执行准备已达上限，请先检查原准备记录。')
        localStorage.setItem(storageKey, JSON.stringify(input)); setCommand(input)
      }
      const prepared = conversationValue(await client.requirements.prepareExecution(conversationId, draftId, input))
      if (!valid(source, ticket)) return
      if (prepared.commandId !== input.commandId || prepared.task.taskId !== receipt.task?.taskId || projectRootKey(prepared.task.root) !== projectRootKey(receipt.task?.root)) throw new Error('执行准备回执不是原任务，未进入其他工程。')
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
  return <Modal open onClose={onClose} width={960} ariaLabel="Trellis 执行流程" placement="center"><section className="requirement-execution my-scrollbar">
    <header className="requirement-execution-header"><GitBranch size={17} aria-hidden="true" /><h2 className="my-item-title">Trellis 执行流程</h2><Button variant="ghost" size="sm" aria-label="关闭执行流程" onClick={onClose}><X size={15} /></Button></header>
    <div className="requirement-execution-body">
      {pending === 'read' && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在核对固定材料…</p>}
      {view?.draft.handoff?.task && <><h3 className="my-item-title">{view.draft.handoff.task.title}</h3><p className="my-item-description break-all">{view.draft.handoff.task.root}</p><div className="requirement-execution-inputs"><span className="my-item-description"><Check size={13} />已确认需求</span><span className="my-item-description"><Check size={13} />独立计划</span><span className="my-item-description"><Check size={13} />固定来源</span></div></>}
      {error && <div className="requirement-workbench-feedback" role="alert"><CircleAlert size={14} /><span className="my-item-title">执行准备未完成</span><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => view ? void prepare() : setAttempt(value => value + 1)}>检查原准备</Button><details><summary className="my-item-description">原因</summary><pre>{error}</pre></details></div>}
      {result?.state === 'prepared' && result.session && result.origin && result.snapshot ? <PreparedWorkflow result={result} session={result.session} origin={result.origin} onClose={onClose} /> : view && <>
        <label className="requirement-execution-engine"><span className="my-item-title">执行引擎</span>{command ? <span className="my-item-description">{runtimes.find(runtime => runtime.id === command.agentId)?.name ?? command.agentId}</span> : <select className="my-input" value={agentId} disabled={Boolean(pending)} onChange={event => setAgentId(event.target.value)} aria-label="Trellis 执行引擎">{available.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}</select>}</label>
        {!command && !available.length && <div className="requirement-workbench-line"><span className="my-item-description">未找到可用执行引擎</span><Button size="sm" variant="ghost" onClick={() => { onClose(); openConversationSettings() }}>打开引擎设置</Button></div>}
        {result?.detail && <div className="requirement-execution-state"><span className="my-item-title">{result.state === 'preparing' ? '原会话准备中' : result.state === 'uncertain' ? '原准备待核对' : '原准备未完成'}</span><details><summary className="my-item-description">详情</summary><pre>{result.detail}</pre></details></div>}
        {result?.session && <Button size="sm" variant="outline" onClick={() => {
          const session = result.session
          if (!session || !canInteract() || projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(result.task.root)) return
          useMy.setState({ taskConversationTarget: null, agentSessionTarget: session.sessionId }); onClose(); useApp.getState().setPage('acp')
        }}>打开原执行会话</Button>}
        <div className="requirement-workbench-line"><Button size="sm" variant="primary" disabled={Boolean(pending) || !command && (!agentId || !available.length)} onClick={() => void prepare()}>{pending === 'prepare' ? <Loader2 size={14} className="animate-spin" /> : command ? <RefreshCw size={14} /> : <ArrowRight size={14} />}{command ? '核对原执行准备' : '激活任务并准备执行'}</Button><span className="my-item-description">准备完成后预览并确认工作流。</span></div>
      </>}
    </div>
  </section></Modal>
}

function PreparedWorkflow({ result, session: metadata, origin, onClose }: { result: RequirementExecutionPreparation; session: NonNullable<RequirementExecutionPreparation['session']>; origin: NonNullable<RequirementExecutionPreparation['origin']>; onClose(): void }): JSX.Element {
  const session: AcpSessionRecord = { ...metadata, events: [] }
  const controller = useManagedWorkflow({ root: result.task.root, taskDir: result.task.taskDir, sessionId: origin.sessionId, generation: origin.connectionGeneration, enabled: true })
  const canInteract = useInteractionGuard()
  return <DocumentSourceProvider client={null}><div className="requirement-execution-workflow"><div className="requirement-execution-state" role="status"><Check size={14} /><span className="my-item-title">原任务工作流</span><span className="my-item-description">任务{statusLabel(result.task.status)} · 会话{statusLabel(session.status)}</span></div>
    {controller.available ? <Suspense fallback={<p className="my-activity-note">正在打开工作流…</p>}><WorkflowPanel root={result.task.root} taskDir={result.task.taskDir} session={session} controller={controller} onOpenHistory={sessionId => {
      if (!canInteract() || projectRootKey(useApp.getState().snapshot?.meta.root) !== projectRootKey(result.task.root)) return
      useMy.setState({ taskConversationTarget: null, agentSessionTarget: sessionId }); onClose(); useApp.getState().setPage('acp')
    }} /></Suspense> : <p className="my-item-description" role="alert">工作流接口当前不可用，请检查后台连接。</p>}
    {controller.error && <details><summary className="my-item-description">工作流读取详情</summary><pre>{controller.error}</pre></details>}
  </div></DocumentSourceProvider>
}
