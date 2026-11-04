import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, GitBranch, Loader2, PanelTop, Pin, RefreshCw, ShieldQuestion, Square, X } from 'lucide-react'
import type { AcpPermissionPayload, AcpSessionRecord, FlowDef } from '../../../../shared/types'
import type { ExecutionEvent, RunRef } from '../../../../shared/workflow'
import type { WorkflowApplicationEventPage } from '../../../../shared/workflow-application'
import { api } from '../../api'
import { Button, Modal } from '../../my/ui'
import { Select } from '../../components/Select'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowRevision } from './WorkflowRevision'
import { WorkflowRecovery } from './WorkflowRecovery'
import { StageHistory, type StageHistoryTarget } from './StageHistory'
import { PublishWorkflowVersionButton } from '../../team/PublishWorkflowVersionButton'
import { belongsToNode, currentNode, materialName, materialReceipts, observedHandoff, readWorkflowView, recordOf, receiptLabel, saveWorkflowView, stateLabel, type MaterialReceipt, type WorkflowView } from './model'
import type { ManagedWorkflowController } from './use-managed-workflow'
import './workflow.css'

type Props = { root: string; taskDir: string; session: AcpSessionRecord; controller: ManagedWorkflowController; onOpenHistory: (sessionId: string) => void }
const eventLabel = (event: ExecutionEvent): string => ({ 'workflow.driver-dispatching': '执行端已派发', 'workflow.prompt-intent': '记录提示词发送意图', 'workflow.native-provenance': '原生执行端来源', 'workflow.native-task-context': 'Trellis 任务上下文', 'workflow.output-verified': '产物契约核验通过', 'workflow.output-invalid': '产物未满足契约', 'workflow.driver-stop': '原生停止核对', 'workflow.driver-result': '阶段结果已记录', 'workflow.gate-result': '平台产物检查结果', 'workflow.gate-aborted': '平台检查阻止后续执行', 'workflow.preset-boundary': '预设阶段交接', 'workflow.additional-inputs': '其他原生上下文可见性' })[event.type] ?? (event.type.startsWith('workflow.context-') ? `材料${receiptLabel(event.type.slice('workflow.context-'.length))}` : event.type)

export function WorkflowPanel({ root, taskDir, session, controller: c, onOpenHistory }: Props): JSX.Element | null {
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const permissionLifetime = useMemo(() => Symbol('permission-lifetime'), [c.key, session.sessionId, session.connectionGeneration, interactive, signal])
  const currentLifetime = useRef(permissionLifetime); currentLifetime.current = permissionLifetime
  const snapshotRef = useRef(c.snapshot); snapshotRef.current = c.snapshot
  const [preference, setPreference] = useState({ key: c.key, value: readWorkflowView(c.key) })
  const view = preference.key === c.key ? preference.value : readWorkflowView(c.key)
  const [setup, setSetup] = useState(false)
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [flowId, setFlowId] = useState('trellis-managed-v1')
  const [flowInputs, setFlowInputs] = useState<FlowDef['inputs']>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [setupError, setSetupError] = useState('')
  const [historyTarget, setHistoryTarget] = useState<StageHistoryTarget | null>(null)
  const [permissionBusy, setPermissionBusy] = useState<Record<string, boolean>>({})
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({})
  const permissionLocks = useRef(new Map<string, symbol>())
  const [records, setRecords] = useState<{ key: string; events: ExecutionEvent[]; cursor: WorkflowApplicationEventPage['cursor'] | null; more: boolean; busy: boolean; error: string }>({ key: '', events: [], cursor: null, more: false, busy: false, error: '' })
  const ticket = useRef(0)
  const keyRef = useRef(c.key); keyRef.current = c.key
  const panel = useRef<HTMLElement>(null)
  const disclosure = useRef<HTMLButtonElement>(null)
  const contentId = useId()
  const graph = c.snapshot?.graph ?? c.preview?.graph ?? null
  const selected = graph?.nodes.find((node) => node.nodeId === view.selected) ?? graph?.nodes.find((node) => node.nodeId === currentNode(c.snapshot)) ?? graph?.nodes[0]
  const actual = c.snapshot?.nodes.find((node) => node.nodeId === selected?.nodeId)
  const selectedEdge = graph?.edges.find((edge) => edge.edgeId === view.selected)
  const currentLabel = graph?.nodes.find((node) => node.nodeId === currentNode(c.snapshot))?.label
  const recordKey = JSON.stringify([c.key, selected?.nodeId, actual?.run ?? c.snapshot?.snapshot?.run.run])
  const selectedRun = actual?.run ?? c.snapshot?.snapshot?.run.run
  const evidence = useMemo(() => [...new Map([...(records.key === recordKey ? records.events : []), ...c.events].map((event) => [event.eventId, event])).values()], [c.events, records, recordKey])
  const receiptWindow = useRef<{ key: string; entries: Map<string, MaterialReceipt> }>({ key: '', entries: new Map() })
  const materials = useMemo(() => {
    if (receiptWindow.current.key !== recordKey) receiptWindow.current = { key: recordKey, entries: new Map() }
    for (const entry of selected ? materialReceipts(evidence, selected.nodeId, selectedRun) : []) {
      const previous = receiptWindow.current.entries.get(entry.ref)
      if (!previous && receiptWindow.current.entries.size >= 64) continue
      const combined = { ...entry, stages: [...new Set([...(previous?.stages ?? []), ...entry.stages])] }
      if (previous?.stages.includes('emitted-to-host') && !entry.stages.includes('emitted-to-host')) { combined.receiver = previous.receiver; combined.includedDigest = previous.includedDigest }
      receiptWindow.current.entries.set(entry.ref, combined)
    }
    return [...receiptWindow.current.entries.values()]
  }, [recordKey, selected?.nodeId, selectedRun?.runId, selectedRun?.revision, evidence])
  const nodeEvents = useMemo(() => evidence.filter((event) => selected && belongsToNode(event, selected.nodeId, selectedRun) && !event.type.startsWith('workflow.context-')), [selected?.nodeId, selectedRun?.runId, selectedRun?.revision, evidence])
  const observationWindow = useRef<{ key: string; records: ExecutionEvent[] | null; events: ExecutionEvent[] }>({ key: '', records: null, events: [] })
  const displayedEvents = useMemo(() => {
    if (observationWindow.current.key !== recordKey || (records.key === recordKey && observationWindow.current.records !== records.events)) observationWindow.current = { key: recordKey, records: records.key === recordKey ? records.events : null, events: [] }
    const known = new Set(observationWindow.current.events.map((event) => event.eventId))
    for (const event of nodeEvents) if (!known.has(event.eventId) && observationWindow.current.events.length < 30) { observationWindow.current.events.push(event); known.add(event.eventId) }
    return observationWindow.current.events
  }, [recordKey, records.key, records.events, nodeEvents])
  const provenance = recordOf(nodeEvents.find((event) => event.type === 'workflow.native-provenance')?.payload)
  const executorId = provenance.executorBindingId ?? recordOf(nodeEvents.find((event) => event.type === 'workflow.driver-dispatching')?.payload).executorBindingId
  const executor = c.snapshot?.snapshot?.manifest?.executors.find((entry) => entry.bindingId === executorId)
  const outputNames = new Map(nodeEvents.filter((event) => event.type === 'workflow.output-verified').flatMap((event) => {
    const outputs = recordOf(event.payload).outputs
    return Array.isArray(outputs) ? outputs.flatMap((entry) => {
      const item = recordOf(entry), material = recordOf(item.material), source = recordOf(material.source)
      return typeof item.ref === 'string' && source.kind === 'trellis-file' && typeof source.relativePath === 'string' ? [[item.ref, source.relativePath] as const] : []
    }) : []
  }))
  const busy = Boolean(c.operation)
  const managed = c.snapshot?.composer.target === 'managed'
  const completed = c.snapshot?.nodes.filter((node) => node.state === 'verified').length ?? 0
  const permissions = (c.snapshot?.stageSessions ?? []).flatMap((stage) => (stage.pendingPermissions ?? []).filter((permission) => permission.sessionId === stage.sessionId && (Boolean(permission.connectionGeneration) && permission.connectionGeneration === stage.connectionGeneration) && permission.sessionId !== session.sessionId))
  const updateView = (patch: Partial<WorkflowView>): void => {
    setPreference((previous) => {
      const base = previous.key === c.key ? previous.value : readWorkflowView(c.key)
      const next = { ...base, ...patch }
      if (previous.key === c.key && JSON.stringify(base) === JSON.stringify(next)) return previous
      saveWorkflowView(c.key, next)
      return { key: c.key, value: next }
    })
  }
  // Select once on first topology. Later stage updates never move a reader.
  useEffect(() => { if (graph?.nodes.length && view.selected === null) updateView({ selected: currentNode(c.snapshot) ?? graph.nodes[0].nodeId }) }, [c.key, graph?.nodes[0]?.nodeId, view.selected])
  useEffect(() => { ticket.current++; setSetup(false); setHistoryTarget(null); setSetupError(''); setPermissionBusy({}); setPermissionErrors({}); setInputs({}) }, [c.key, session.sessionId, session.connectionGeneration, interactive])
  const loadRecords = async (more = false): Promise<void> => {
    if (!selected || !canInteract()) return
    const run = actual?.run ?? c.snapshot?.snapshot?.run.run
    if (!run) return
    const serial = ++ticket.current, owner = c.key, key = recordKey
    setRecords((old) => ({ key, events: more && old.key === key ? old.events : [], cursor: more && old.key === key ? old.cursor : null, more: false, busy: true, error: '' }))
    try {
      const result = await api.managedWorkflow.events(root, { taskDir, run, cursor: more && records.key === key ? records.cursor : null, limit: 100 })
      if (serial !== ticket.current || keyRef.current !== owner || !canInteract()) return
      if (!result.ok) throw Error(result.error)
      setRecords((old) => ({ key, events: [...new Map([...(more && old.key === key ? old.events : []), ...result.value.items.map((item) => item.event)].map((event) => [event.eventId, event])).values()].slice(-500), cursor: result.value.cursor, more: result.value.hasMore, busy: false, error: result.value.resetRequired ? '记录游标已重置，请重新读取。' : '' }))
    } catch (error) { if (serial === ticket.current && keyRef.current === owner) setRecords((old) => ({ ...old, busy: false, error: error instanceof Error ? error.message : '无法读取阶段记录' })) }
  }
  const openSetup = async (): Promise<void> => {
    if (!canInteract()) return
    const serial = ++ticket.current, owner = c.key
    setSetup(true); setSetupError('')
    try {
      const result = await api.managedWorkflow.templates(root)
      if (serial !== ticket.current || owner !== keyRef.current || !canInteract()) return
      if (!result.ok) throw Error(result.error)
      setTemplates(result.value)
    } catch (error) { if (serial === ticket.current) setSetupError(error instanceof Error ? error.message : '无法读取工作流') }
  }
  const chooseFlow = async (id: string): Promise<void> => {
    c.clearPreview()
    setFlowId(id); setFlowInputs([]); setInputs({}); setSetupError('')
    if (id === 'trellis-managed-v1') return
    const serial = ++ticket.current
    try {
      const result = await api.flowRead(id)
      if (serial !== ticket.current || !canInteract()) return
      if (!result.ok || !result.def) throw Error(result.error ?? '工作流不可读')
      setFlowInputs(result.def.inputs); setInputs(Object.fromEntries(result.def.inputs.map((entry) => [entry.name, entry.default ?? ''])))
    } catch (error) { if (serial === ticket.current) setSetupError(error instanceof Error ? error.message : '输入项读取失败') }
  }
  const respond = async (permission: AcpPermissionPayload, optionId: string): Promise<void> => {
    if (!canInteract() || permissionLocks.current.has(permission.requestId) || !permission.options.some((option) => option.optionId === optionId)) return
    const owner = c.key, lifetime = permissionLifetime, current = snapshotRef.current?.stageSessions.some((stage) => stage.sessionId === permission.sessionId && Boolean(permission.connectionGeneration) && stage.connectionGeneration === permission.connectionGeneration && stage.pendingPermissions?.some((entry) => entry.requestId === permission.requestId && entry.sessionId === permission.sessionId && entry.connectionGeneration === permission.connectionGeneration && entry.options.some((option) => option.optionId === optionId)))
    if (!current) return
    const lock = Symbol(permission.requestId)
    permissionLocks.current.set(permission.requestId, lock)
    setPermissionBusy((old) => ({ ...old, [permission.requestId]: true }))
    try {
      const result = await api.acpPermissionRespond(permission.requestId, optionId)
      if (owner !== keyRef.current || currentLifetime.current !== lifetime || signal?.aborted || !canInteract()) return
      if (!result.ok) throw Error(result.error ?? '授权响应未确认')
      await c.refresh()
    } catch (error) { if (owner === keyRef.current && currentLifetime.current === lifetime && !signal?.aborted && canInteract()) setPermissionErrors((old) => ({ ...old, [permission.requestId]: error instanceof Error ? error.message : '响应失败' })) }
    finally { if (permissionLocks.current.get(permission.requestId) === lock) { permissionLocks.current.delete(permission.requestId); if (owner === keyRef.current) setPermissionBusy((old) => ({ ...old, [permission.requestId]: false })) } }
  }
  const openVersion = (ref: string, run?: RunRef): void => { if (canInteract()) void c.openArtifact(ref, run) }
  // Page the selected, fixed stage revision only when it becomes visible or changes.
  useEffect(() => { if (!view.collapsed && !setup && interactive && selectedRun && actual) void loadRecords() }, [recordKey, view.collapsed, setup, interactive])
  if (!c.available) return null
  const retainedRun = c.snapshot?.snapshot?.run.run ?? null
  const originKey = JSON.stringify([c.key, session.sessionId, session.connectionGeneration])
  if (!taskDir) return <div className="wf-recovery-launcher"><WorkflowRecovery root={root} run={null} originKey={originKey} onOpenHistory={onOpenHistory} /></div>
  return <section ref={panel} className="wf-panel" data-dock={view.dock} data-collapsed={view.collapsed} aria-label="Trellis 工作流" onKeyDown={(event) => {
    if (event.key === 'Escape' && !view.collapsed && !setup && !(event.target as HTMLElement).closest('[role="dialog"],.my-menu')) { event.preventDefault(); event.stopPropagation(); updateView({ collapsed: true }); disclosure.current?.focus({ preventScroll: true }) }
  }}>
    <header className="wf-heading">
      <button ref={disclosure} type="button" className="wf-disclosure" aria-expanded={!view.collapsed} aria-controls={contentId} onClick={() => updateView({ collapsed: !view.collapsed })}>
        <GitBranch size={15} aria-hidden="true" /><strong>Trellis</strong><span className="wf-heading-state">{c.loading ? '读取运行记录…' : c.snapshot?.snapshot ? `${currentLabel ?? ''} · ${stateLabel(c.snapshot.snapshot.run.state)}` : '未启动工作流'}</span>{graph && <span className="wf-heading-count" title="已核验产物的阶段数 / 预设阶段数">{completed}/{graph.nodes.length}</span>}{permissions.length > 0 && <span className="wf-pending-count">待授权 {permissions.length}</span>}{view.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </button>
      <div className="wf-heading-actions"><button type="button" className="my-icon-control" title="刷新工作流状态" aria-label="刷新工作流状态" onClick={() => { void c.refresh() }}><RefreshCw size={13} /></button>
        {managed ? <button type="button" className="my-control my-control-sm" disabled={busy} onClick={() => { void c.stop() }}><Square size={12} />{c.operation === 'stop' ? '请求停止…' : '停止任务'}</button> : <button type="button" className="my-control my-control-sm" disabled={busy || session.status !== 'ready' || !session.connectionGeneration} onClick={() => { void openSetup() }}>预览运行</button>}
        <button type="button" className="my-icon-control wf-dock-control" aria-label={view.dock === 'composer' ? '停靠到会话右上角' : '回到输入框上方'} title={view.dock === 'composer' ? '停靠到会话右上角' : '回到输入框上方'} onClick={() => updateView({ dock: view.dock === 'composer' ? 'corner' : 'composer' })}>{view.dock === 'composer' ? <Pin size={13} /> : <PanelTop size={14} />}</button></div>
    </header>
    <div className="wf-secondary-actions"><WorkflowRevision root={root} taskDir={taskDir} run={retainedRun} originKey={originKey} disabled={busy || c.loading || !managed || Boolean(c.snapshot?.recoveryRequired)} onRefresh={c.refresh} onOpenMaterial={(ref, run) => c.openArtifact(ref, run)} /><WorkflowRecovery root={root} run={retainedRun} originKey={originKey} onOpenHistory={onOpenHistory} /></div>
    {(c.error || c.notice || c.gap) && <p className="wf-notice" role={c.error ? 'alert' : 'status'}>{c.error || c.notice || '记录游标已重置，当前节点状态来自最新快照；旧记录可按阶段重新读取。'}</p>}
    {permissions.length > 0 && <div className="wf-permissions">{permissions.map((permission) => <section key={permission.requestId} aria-label="阶段原生授权" className="wf-permission"><div><ShieldQuestion size={15} /><strong>{permission.toolCall?.title ?? '执行阶段等待授权'}</strong></div><p>选择仅作用于此阶段的原生请求。</p><details><summary>授权来源</summary><p>会话 {permission.sessionId} · 连接 {permission.connectionGeneration} · 请求 {permission.requestId}</p></details><div className="wf-permission-options">{permission.options.map((option) => <Button key={option.optionId} size="sm" variant={option.kind.startsWith('reject') ? 'outline' : 'neutral'} disabled={permissionBusy[permission.requestId] || permissionLocks.current.has(permission.requestId)} onClick={() => { void respond(permission, option.optionId) }}>{option.name}</Button>)}</div>{permissionErrors[permission.requestId] && <p role="alert">{permissionErrors[permission.requestId]}</p>}</section>)}</div>}
    <div id={contentId} hidden={view.collapsed} className="wf-content">
      {graph ? <><WorkflowCanvas graph={graph} snapshot={c.snapshot} view={view} onView={updateView} onSelected={(selectedId) => { ticket.current++; updateView({ selected: selectedId }) }} locate={currentNode(c.snapshot)} />
        <div className="wf-details my-scrollbar" aria-label="所选流程记录">
          {selectedEdge ? <section className="wf-selected-edge"><strong>预设{selectedEdge.kind === 'sequence' ? '顺序' : selectedEdge.kind === 'retry' ? '有界重试' : '依赖'}</strong><p>{graph.nodes.find((node) => node.nodeId === selectedEdge.from)?.label} → {graph.nodes.find((node) => node.nodeId === selectedEdge.to)?.label}</p><p>{observedHandoff(evidence, c.snapshot, selectedEdge) ? '有预设阶段交接记录，产物与接收方可在对应阶段查看。' : '这是定义中的依赖，尚未观察到该交接记录。'}</p></section> : selected && <>
            <div className="wf-detail-title"><strong>{selected.label}</strong><span>{stateLabel(actual?.state ?? 'planned')}</span><button type="button" className="my-control my-control-sm" disabled={!actual || records.busy} onClick={() => { void loadRecords() }}>{records.busy ? '读取中…' : '读取阶段记录'}</button></div>
            {actual?.sessionId && <div className="wf-executor"><button type="button" disabled={!actual.turnId || !actual.run} onClick={() => { if (actual.sessionId && actual.turnId && actual.run && canInteract()) setHistoryTarget({ sessionId: actual.sessionId, turnId: actual.turnId, run: actual.run, historySeq: actual.historySeq, historyCommitted: actual.historyCommitted }) }}>查看本阶段对话<ArrowUpRight size={12} /></button><span>{actual.historyCommitted ? '历史已提交' : '历史提交未确认'}</span>{c.snapshot?.origin?.sessionId !== session.sessionId && c.snapshot?.origin && <button type="button" onClick={() => onOpenHistory(c.snapshot?.origin?.sessionId ?? '')}>回到发起会话</button>}</div>}
            <details className="wf-execution-source"><summary>{selected.kind === 'gate' ? '平台检查来源' : '执行端与配置来源'}</summary>{selected.kind === 'gate' ? <p>此节点由平台依据已固定的产物执行检查，不启动原生会话。实际通过、失败和分支选择以检查记录为准；失败后继续不代表检查通过。</p> : <><p>会话 {actual?.sessionId ?? '未观察到'} · 轮次 {actual?.turnId ?? '未观察到'} · 提交位置 {actual?.historySeq ?? '未观察到'}</p><p>{executor ? `${executor.engineId} · 适配器 ${executor.adapterVersion} · 配置 ${executor.configuration.version}` : typeof provenance.adapterVersion === 'string' ? `适配器 ${provenance.adapterVersion}` : '尚未读取此阶段的执行端来源'}</p><p>引擎版本：{typeof provenance.engineVersion === 'string' && provenance.engineVersion !== 'unknown' ? provenance.engineVersion : '未观察到'}；原生上下文与子代理记录以宿主实际回执为准。</p>{executor && <p>配置标识 {executor.configuration.assetId} · 摘要 {executor.configuration.digest}</p>}</>}</details><div className="wf-evidence-columns"><section><h4>输入与规范 <span>{materials.length}</span></h4>{materials.length ? materials.map((entry) => <div key={entry.ref} className="wf-material-row"><button type="button" title={materialName(entry.material)} disabled={busy} onClick={() => openVersion(entry.ref, actual?.run ?? undefined)}>{materialName(entry.material)}</button><small title={`接收方 ${entry.receiver} · 完整摘要 ${entry.material.sourceDigest ?? '未观察到'}`}>{entry.material.version.slice(0, 10)} · {entry.stages.map(receiptLabel).join(' / ')} · {entry.includedDigest ? entry.includedDigest === entry.material.sourceDigest ? '完整内容' : '内容节选' : '未确认提供正文'}</small></div>) : <p>尚未读取本阶段材料回执。</p>}</section><section><h4>固定版本产物 <span>{actual?.outputRefs.length ?? 0}</span></h4>{actual?.outputRefs.length ? actual.outputRefs.map((ref, index) => <div key={ref} className="wf-material-row"><button type="button" disabled={busy} onClick={() => openVersion(ref, actual.run ?? undefined)}>{outputNames.get(ref)?.split('/').at(-1) ?? `阅读产物 ${index + 1}`}<ArrowUpRight size={12} /></button>{actual.run && <PublishWorkflowVersionButton expectedRoot={root} source={{ kind: "task-run", taskDir, run: actual.run, ref }} title={outputNames.get(ref)?.split("/").at(-1) ?? selected.label} />}<details><summary>固定版本来源</summary><small>{ref}</small></details></div>) : <p>尚无已记录的产物版本。</p>}</section></div>
            <details className="wf-observations"><summary>阶段记录与可见范围 <span>{nodeEvents.length}</span></summary><p>原生引擎内部子代理及未报告的读取行为：未观察到。当前窗口保留最多 30 条记录，主动读取可刷新；产物核验不代表业务验收或 QA 通过。</p>{displayedEvents.map((event) => <div className="wf-event-row" key={event.eventId}><time>{new Date(event.occurredAt).toLocaleTimeString()}</time><span>{eventLabel(event)}</span><details><summary>来源</summary><pre>{JSON.stringify({ source: event.source, attribution: event.attribution, payload: event.payload }, null, 2)}</pre></details></div>)}{records.more && records.key === recordKey && <button type="button" className="my-control my-control-sm" disabled={records.busy} onClick={() => { void loadRecords(true) }}>读取后续记录</button>}{records.error && records.key === recordKey && <p role="alert">{records.error}</p>}</details>
          </>}
        </div></> : <div className="wf-empty"><GitBranch size={23} /><p>从当前任务启动可追溯的 Trellis 工作流。</p><small>预览输入、执行端与产物契约后，再开始运行。</small></div>}
    </div>
    {managed && <div className="wf-composer-target">当前输入区关联受管任务。阶段反馈尚未接入，草稿会保留；需要普通对话时先等待或停止任务。</div>}
    <StageHistory target={interactive ? historyTarget : null} onClose={() => setHistoryTarget(null)} onOpenFull={onOpenHistory} />
    <Modal open={setup && interactive} onClose={() => { ticket.current++; setSetup(false) }} ariaLabel="预览 Trellis 工作流" width={660}>
      <div className="wf-setup"><header><h2>预览工作流</h2><button type="button" className="my-icon-control" aria-label="关闭工作流预览" onClick={() => { ticket.current++; setSetup(false) }}><X size={16} /></button></header><p>任务 {taskDir} · 命令接纳、原生运行与产物核验会分别记录。</p><Select ariaLabel="工作流模板" disabled={busy} value={flowId} options={templates.map((template) => ({ value: template.id, label: template.name }))} onChange={(id) => { void chooseFlow(id) }} />
        {flowInputs.map((entry) => <label className="wf-input" key={entry.name}>{entry.label}{entry.required && '（必填）'}<input className="my-input" disabled={busy} value={inputs[entry.name] ?? ''} onChange={(event) => { c.clearPreview(); setInputs((old) => ({ ...old, [entry.name]: event.target.value })) }} /></label>)}
        <Button size="sm" variant="outline" disabled={busy || flowInputs.some((entry) => entry.required && !inputs[entry.name]?.trim())} onClick={() => { void c.createPreview(flowId, inputs) }}>{c.operation === 'preview' ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}核对运行输入</Button>
        {c.preview && <section className="wf-preview-summary"><h3>已核对 {c.preview.graph.nodes.length} 个阶段 · {c.preview.materials.length} 份材料</h3><ol>{c.preview.graph.nodes.map((node) => <li key={node.nodeId}>{node.label}</li>)}</ol>{c.preview.executorBindings.map((executor) => <p key={executor.bindingId}>{executor.engineId} · 适配器 {executor.adapterVersion} · 引擎版本 {executor.engineVersion === 'unknown' ? '未观察到' : executor.engineVersion}</p>)}<details><summary>材料版本与可见范围</summary>{c.preview.materials.map((entry) => <details key={entry.ref}><summary>{entry.kind} · {entry.source} · {entry.inclusion === 'full' ? '完整内容' : entry.inclusion ?? '未确认'}</summary><p>版本 {entry.version}</p>{entry.text !== undefined && <pre>{entry.text}</pre>}</details>)}{c.preview.limitations.map((line) => <p key={line}>{line}</p>)}</details><Button variant="primary" disabled={busy || c.preview.expiresAt <= Date.now()} onClick={() => { void c.start().then((accepted) => { if (accepted && canInteract()) { setSetup(false); updateView({ collapsed: false }) } }) }}>{c.operation === 'start' ? '提交中…' : '确认并开始'}</Button></section>}
        {(setupError || c.notice) && <p role="alert" className="wf-notice">{setupError || c.notice}</p>}
      </div>
    </Modal>
  </section>
}
