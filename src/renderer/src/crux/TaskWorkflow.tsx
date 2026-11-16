import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowRight, Check, CheckCheck, CircleCheck, CircleX, ClipboardCheck, Code2, FileQuestion, FileText, Loader2, MoreHorizontal, Palette, Pencil, Play, RotateCcw, Send, ShieldCheck, Users, X, type LucideIcon } from 'lucide-react'
import type { CruxExecutorRef, CruxSnapshot, CruxTask, CruxTaskAction, CruxTaskStage, CruxTaskWorkKind, CruxTransitionTaskInput } from '@shared/crux'
import type { CruxWorkLocal } from '@shared/crux-work'
import type { ProductTaskResults } from '@shared/product-task-entry'
import type { TaskMaterialInputReference } from '@shared/task-material-inputs'
import { taskInputCanonical } from '@shared/team-task-inputs'
import { getCruxTaskActions, getCruxTaskStageMetadata, isCruxTriageManager } from '@shared/crux-domain/workflow'
import { api, hasIpc } from '../api'
import { Button, Dropdown, DropdownItem, Modal, Tooltip } from '../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { TeamMarkdown } from '../team/TeamMarkdown'
import { availableExecutionTargets, memberOf, useCrux } from './store'
import { Field, inputClass, textareaClass, Select } from './ui'
import { openLocalWork } from './local-work'
import { nativeDevelopmentApi } from './development/bridge'
import { TaskDevelopmentCard } from './development/TaskDevelopmentCard'
import { productTaskApi } from './development/ProductTaskEntry'
import { TaskExecutionResults } from './TaskExecutionResults'
import { TaskPlanningCard } from './development/TaskPlanningCard'
import { canReadTaskSpace, taskSourceKey, useTaskSource } from './pages/task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './pages/task-detail/task-drafts'
import { TaskMaterials, type TaskMaterialEntryRequest, type TaskMaterialReviewState } from './task-materials/TaskMaterials'
import { ManualDesignDraft, WorkflowWorkbench } from './workflow-stage/WorkflowWorkbench'
import { WorkflowAgentSetup } from './workflow-stage/WorkflowAgentSetup'
import { WorkflowSpaceMembers } from './workflow-stage/WorkflowSpaceMembers'
import { recipientRole, workflowRecipients } from './workflow-stage/recipients'
import { DesignRevisionPicker } from './workflow-stage/DesignRevisionPicker'
import { designReferenceBody, matchesDesignReference, taskDesignReference, type DesignReference } from './workflow-stage/design-reference'
import './workflow-stage/workflow-stage.css'

export const WORKFLOW_ACTION_LABELS: Record<CruxTaskAction, string> = {
  accept: '先接纳', arrange: '安排处理', request_info: '请补充', supplement: '补充信息', decline: '不采纳',
  start_design: '开始人工设计', submit_design: '提交设计评审', approve_design: '确认设计并交给开发', return_design: '退回设计',
  begin_development: '开始处理', approve_plan: '确认技术方案', submit_test: '交给测试', return_development: '退回开发',
  pass_test: '测试通过', accept_delivery: '验收通过', return_delivery: '未满足需求', submit_delivery: '提交交付成果', reassign: '转交'
}
const ACTION_ICONS: Record<CruxTaskAction, LucideIcon> = {
  accept: Check, arrange: Users, request_info: FileQuestion, supplement: Pencil, decline: X,
  start_design: Palette, submit_design: Send, approve_design: CheckCheck, return_design: RotateCcw,
  begin_development: Play, approve_plan: ClipboardCheck, submit_test: Send, return_development: RotateCcw,
  pass_test: ShieldCheck, accept_delivery: CheckCheck, return_delivery: RotateCcw, submit_delivery: Send, reassign: Users
}
const BODY_LABELS: Partial<Record<CruxTaskAction, string>> = {
  request_info: '需要补充的内容', supplement: '补充说明', decline: '不采纳原因', submit_design: '设计内容与评审重点',
  approve_design: '交接说明（选填）', return_design: '调整意见', approve_plan: '实现方案与检查范围',
  submit_test: '改动说明与检查结果', return_development: '复现步骤、实际结果与预期', pass_test: '测试记录（选填）',
  accept_delivery: '验收说明或证据', return_delivery: '未满足的验收点', submit_delivery: '产出链接或交付说明', reassign: '交接说明（选填）'
}
const BODY_REQUIRED = new Set<CruxTaskAction>(['request_info', 'supplement', 'decline', 'submit_design', 'return_design', 'approve_plan', 'submit_test', 'return_development', 'accept_delivery', 'return_delivery', 'submit_delivery'])
const HANDED = new Set<CruxTaskAction>(['arrange', 'reassign', 'request_info', 'supplement', 'submit_design', 'approve_design', 'return_design', 'submit_test', 'return_development', 'pass_test', 'return_delivery', 'submit_delivery'])

function actorId(snapshot: CruxSnapshot): string | null {
  const context = useCrux.getState().workspaceContext
  return context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id ?? null : null)
}

function WorkflowRail({ task, cancelled }: { task: CruxTask; cancelled: boolean }): JSX.Element {
  const stage = task.workflow?.stage
  const stageIndex = (value: CruxTaskStage | undefined): number => !value || ['accepted', 'needs_info'].includes(value) ? 0 : ['design_ready', 'designing', 'design_review'].includes(value) ? 1 : ['dev_ready', 'planning', 'developing'].includes(value) ? 2 : value === 'testing' ? 3 : 4
  const current = task.triagePending ? 0 : stageIndex(stage === 'needs_info' ? task.workflow?.resumeStage : stage)
  const visited = new Set((task.workflow?.history ?? []).flatMap((event) => [stageIndex(event.fromStage), stageIndex(event.toStage)]))
  const steps = (task.workKind === 'general'
    ? [{ label: '接纳', icon: FileText, index: 0 }, { label: '处理', icon: Pencil, index: 2 }, { label: '验收', icon: ShieldCheck, index: 4 }]
    : [{ label: '接纳', icon: FileText, index: 0 }, { label: '设计', icon: Palette, index: 1 }, { label: '开发', icon: Code2, index: 2 }, { label: '测试', icon: ClipboardCheck, index: 3 }, { label: '验收', icon: ShieldCheck, index: 4 }]).filter((step) => step.index !== 1 || !task.workflow?.history.some((event) => event.action === 'arrange' && event.toStage === 'dev_ready'))
  return <ol className="collab-stage-rail" aria-label="任务交接阶段">{steps.map(({ label, icon: Icon, index }, i) => {
    const complete = visited.has(index) && (index < current || stage === 'done')
    const skipped = index < current && !visited.has(index)
    return <li key={label} data-state={cancelled ? 'cancelled' : complete ? 'complete' : skipped ? 'skipped' : index === current ? 'current' : 'upcoming'} aria-current={!cancelled && stage !== 'done' && index === current ? 'step' : undefined}><span className="collab-stage-icon">{cancelled ? <X size={14} /> : complete ? <Check size={14} /> : <Icon size={14} />}</span><span>{label}{skipped ? '（未经过）' : ''}</span>{i < steps.length - 1 && <ArrowRight size={12} className="collab-stage-arrow" aria-hidden="true" />}</li>
  })}</ol>
}

export function TaskWorkflow({ snapshot, task, resourceRefresh = 0, onOpenInputs, onMaterialCommitted }: { snapshot: CruxSnapshot; task: CruxTask; resourceRefresh?: number; onOpenInputs?(): void; onMaterialCommitted?(): void }): JSX.Element {
  const { workspaceContext, busy, run, developmentRevision } = useCrux()
  const actor = actorId(snapshot)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const [executionResultsRevision, setExecutionResultsRevision] = useState(0)
  const [planningOccupied, setPlanningOccupied] = useState(false)
  const [planningOwnerRevision, setPlanningOwnerRevision] = useState(0)
  const planningOwner = useRef<boolean | null>(null)
  const [dialog, setDialog] = useState<{ action: CruxTaskAction; stage: CruxTaskStage | undefined; body?: string; plan?: TaskMaterialInputReference } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [openDevelopment, setOpenDevelopment] = useState(0)
  const [materialEntry, setMaterialEntry] = useState<TaskMaterialEntryRequest>()
  const [reviewState, setReviewState] = useState<TaskMaterialReviewState>({ state: 'loading', document: null, refreshing: true, incomplete: false })
  const [success, setSuccess] = useState<{ updatedAt: string; message: string } | null>(null)
  const workbench = useRef<HTMLDivElement>(null)
  const materials = useRef<HTMLDivElement>(null)
  const development = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const scopeKey = workspaceContext.key
  const sourceKey = taskSourceKey(snapshot, workspaceContext)
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const writable = hasIpc && !snapshot.spaces.find((space) => space.id === task.spaceId)?.archived
  const owns = (): boolean => {
    const current = useCrux.getState()
    return mounted.current && canInteract() && !interactionSignal?.aborted && current.developmentRevision === developmentRevision && Boolean(current.snapshot &&
      taskSourceKey(current.snapshot, current.workspaceContext) === sourceKey && current.openTaskId === task.id &&
      canReadTaskSpace(current.snapshot, current.workspaceContext, task.spaceId) &&
      !current.snapshot.spaces.find((space) => space.id === task.spaceId)?.archived &&
      current.snapshot.tasks.some((item) => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId &&
        item.workKind === task.workKind && (item.workflow?.handlerId ?? item.assigneeIds[0]) === handler))
  }
  const canHandle = Boolean(writable && actor && (handler === actor || ((task.triagePending || !task.workflow || task.workflow.stage === 'accepted') && (task.creatorId === actor || isCruxTriageManager(snapshot, task.spaceId, actor)))))
  const canTransfer = Boolean(writable && actor && isCruxTriageManager(snapshot, task.spaceId, actor))
  const roles = task.workflow?.deliveryState?.roles
  const canAct = (action: CruxTaskAction): boolean => canHandle || Boolean(writable && actor && roles &&
    (['pass_test', 'return_development'].includes(action) ? roles.testOwnerId === actor : ['accept_delivery', 'return_delivery'].includes(action) && (task.workKind === 'general' ? roles.acceptanceOwnerId : roles.testOwnerId) === actor))
  const canInspectBinding = Boolean(canHandle && handler === actor && task.workKind === 'code')
  const hasBegunDevelopment = Boolean(task.workflow && (['planning', 'developing', 'testing', 'acceptance', 'done'].includes(task.workflow.stage) || task.workflow.history.some((event) => event.action === 'begin_development')))
  const showDevelopment = (canInspectBinding || workspaceContext.state !== 'local' && task.workKind === 'code') && !task.triagePending && (task.workflow?.stage === 'dev_ready' || hasBegunDevelopment)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function completed(action: CruxTaskAction, updated: CruxSnapshot): void {
    if (!source.owns()) return
    const next = updated.tasks.find((item) => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId)
    if (!next?.workflow) return
    const nextHandler = updated.members.find((item) => item.id === next.workflow?.handlerId)?.name ?? '待核对处理人'
    const ended = next.workflow.stage === 'done'
    const cancelled = updated.taskStatuses.find((item) => item.id === next.statusId)?.category === 'cancelled'
    setError('')
    setSuccess({ updatedAt: next.updatedAt, message: `${WORKFLOW_ACTION_LABELS[action]}已确认 · ${cancelled ? '任务已取消' : `当前${getCruxTaskStageMetadata(next.workflow.stage).label}`} · ${ended ? `最后处理同事：${nextHandler}` : `由 ${nextHandler} 接续处理`}` })
    setDialog(null)
    requestAnimationFrame(() => { if (source.owns()) { workbench.current?.focus({ preventScroll: true }); workbench.current?.scrollIntoView({ block: 'nearest' }) } })
  }
  function openMaterial(kind: TaskMaterialEntryRequest['kind'], mode: 'work' | 'review' = 'work'): void {
    if (!source.owns()) return
    setMaterialEntry((current) => ({ kind, mode, requestId: (current?.requestId ?? 0) + 1 }))
    requestAnimationFrame(() => { if (source.owns()) materials.current?.scrollIntoView({ block: 'nearest' }) })
  }
  const openDesign = (): void => openMaterial('design')
  async function enterPlanning(prepared: CruxWorkLocal): Promise<void> {
    if (!owns()) return
    if (task.workflow?.stage === 'dev_ready') {
      if (!task.acceptanceCriteria?.length) throw Error('请先补充验收标准')
      const result = await run('开始处理', async () => owns()
        ? api.crux.transitionTask({ taskId: task.id, action: 'begin_development', expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt })
        : { ok: false as const, error: '原任务来源已不可操作，请重新打开。' })
      if (!owns()) return
      if (!result?.ok) throw Error(result && !result.ok ? result.error : '操作尚未完成，请核对任务后重试')
    }
    setError('')
    await openLocalWork(scopeKey, task.id, prepared)
  }
  async function begin(): Promise<void> {
    if (!owns() || inFlight.current || useCrux.getState().busy) return
    if (!nativeDevelopmentApi()) { development.current?.focus({ preventScroll: true }); development.current?.scrollIntoView({ block: 'nearest' }); return }
    if (!task.acceptanceCriteria?.length) { setError('请先补充验收标准'); return }
    if (workspaceContext.state !== 'local' && productTaskApi() && task.workflow?.stage === 'dev_ready') {
      inFlight.current = true; setPending(true); setError('')
      try {
        const entry = await productTaskApi()?.read({ workspaceKey: scopeKey, taskId: task.id })
        if (!owns()) return
        if (!entry?.ok) { setError(entry && !entry.ok ? entry.error : '开发环境尚未核对。'); return }
        if (entry.value.owner === 'native') {
          const result = await run('开始处理', () => api.crux.transitionTask({ taskId: task.id, action: 'begin_development', expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt }))
          if (!source.owns()) return
          if (!result?.ok) { setError(result && !result.ok ? result.error : '操作未完成，请核对原任务。'); return }
          completed('begin_development', result.data)
        }
      } catch (cause) { if (source.owns()) setError(cause instanceof Error ? cause.message : '开发环境尚未核对。'); return }
      finally { inFlight.current = false; if (mounted.current) setPending(false) }
    }
    setError(''); setOpenDevelopment((value) => value + 1)
  }
  async function invoke(action: CruxTaskAction): Promise<void> {
    if (!owns() || inFlight.current || useCrux.getState().busy) return
    if (action === 'begin_development') { await begin(); return }
    if (action === 'approve_plan' && workspaceContext.state === 'connected' && api.cruxGovernance) {
      if (planningOccupied) { setError('请先停止并核对原规划清理。'); return }
      inFlight.current = true; setPending(true); setError('')
      try {
        const query = { workspaceKey: scopeKey, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }
        const inputs = await api.cruxGovernance.inputs(query)
        if (!source.owns()) return
        if (!inputs.ok) throw Error(inputs.error)
        const plans = inputs.value.current?.documents.filter(reference => reference.kind === 'implement') ?? []
        if (plans.length === 1) {
          const plan = plans[0], document = await api.cruxGovernance.readDocument({ ...query, reference: plan })
          if (!source.owns()) return
          if (!document.ok) throw Error(document.error)
          if (taskInputCanonical(document.value.reference) !== taskInputCanonical(plan)) throw Error('原技术方案固定版本已变化，请重新核对任务输入。')
          setDialog({ action, stage: task.workflow?.stage, body: document.value.text, plan })
        } else if (plans.length > 1) throw Error('任务采用了多份技术方案，请先在采用输入中明确本次方案。')
        else setDialog({ action, stage: task.workflow?.stage })
      } catch (cause) { if (source.owns()) setError(cause instanceof Error ? cause.message : '已采用方案读取失败。') }
      finally { inFlight.current = false; if (mounted.current) setPending(false) }
      return
    }
    if (action === 'start_design' || action === 'accept') {
      inFlight.current = true
      setPending(true); setError('')
      try {
        const result = await run(WORKFLOW_ACTION_LABELS[action], async () => owns()
          ? api.crux.transitionTask({ taskId: task.id, action, expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt })
          : { ok: false as const, error: '原任务来源已不可操作，请重新打开。' })
        if (!source.owns()) return
        if (result?.ok) { completed(action, result.data); if (action === 'start_design') openDesign() }
        else setError(result && !result.ok ? result.error : '操作未完成')
      } finally { inFlight.current = false; if (mounted.current) setPending(false) }
      return
    }
    setDialog({ action, stage: task.workflow?.stage })
  }
  const cancelled = snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category === 'cancelled'
  const closed = cancelled || snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category === 'done'
  const actions = !closed ? getCruxTaskActions(task) : []
  const reviewingPrd = reviewState.state === 'ready' && reviewState.document?.latestSubmission?.status === 'pending'
  const primary = task.triagePending && actions.includes('arrange') && canHandle ? 'arrange' : actions.find((action) => canAct(action) && !['request_info', 'decline', 'return_design', 'return_development', 'return_delivery', 'reassign'].includes(action))
  const secondary = actions.filter((action) => canAct(action) && action !== primary && !['request_info', 'decline', 'reassign'].includes(action))
  const more = actions.filter((action) => ['request_info', 'decline', 'reassign'].includes(action) && (canHandle || canTransfer && action === 'reassign'))
  const stageLabel = cancelled ? '已取消' : task.triagePending ? '待分拣' : task.workflow ? getCruxTaskStageMetadata(task.workflow.stage).label : '原有工作流'
  const handlerName = memberOf(snapshot, handler)?.name ?? (handler ? '成员不可用' : '待安排')
  const primaryLabel = primary ? primary === 'arrange' && task.triagePending ? '接纳并安排' : WORKFLOW_ACTION_LABELS[primary] : closed ? '流程已结束' : '等待后续处理'
  const nextOwner = primary && HANDED.has(primary) ? (primary === 'arrange' ? '安排后交给下一位负责人' : '完成后交给下一位负责人') : primary ? '由当前负责人继续' : closed ? '无需继续操作' : '等待负责人更新'
  function actionButton(action: CruxTaskAction, primaryAction = false): JSX.Element {
    const Icon = ACTION_ICONS[action]
    const unavailable = action === 'begin_development' && !nativeDevelopmentApi()
    const label = action === 'arrange' && task.triagePending ? '接纳并安排' : WORKFLOW_ACTION_LABELS[action]
    return <Tooltip key={action} label={action === 'approve_plan' && planningOccupied ? '请先停止并核对原规划清理' : unavailable ? '查看原团队、空间与任务的桌面定位信息' : label} side="bottom"><Button variant={primaryAction ? 'primary' : 'outline'} size="sm" disabled={pending || busy || action === 'approve_plan' && planningOccupied} onClick={() => void invoke(action)}>{pending && primaryAction ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}{unavailable ? '在桌面继续开发' : label}</Button></Tooltip>
  }
  return <section className="collab-task-workflow" aria-label="任务流程"><WorkflowRail task={task} cancelled={cancelled} />
    <section className="collab-current-work" aria-label="当前工作">
      <div className="collab-current-work-heading"><div><h3>{stageLabel}</h3></div><span className="collab-current-work-stage">{task.workKind === 'general' ? '日常工作' : '研发工作'}</span></div>
      <div className="collab-current-work-grid">
        <div><span className="collab-current-work-label">当前负责人</span><strong>{handlerName}</strong></div>
        <div><span className="collab-current-work-label">下一步</span><strong>{primaryLabel}</strong><span className="collab-current-work-hint">{nextOwner}</span></div>
      </div>
      <div className="collab-current-work-footer"><span>{task.acceptanceCriteria?.length ? `${task.acceptanceCriteria.length} 项验收标准` : '尚未填写验收标准'}</span><span>{task.workflow?.history.length ? `已记录 ${task.workflow.history.length} 次交接` : '尚未发生交接'}</span></div>
    </section>
    {success?.updatedAt === task.updatedAt && <p role="status" className="workflow-transition-result"><CircleCheck size={17} /><span>{success.message}</span></p>}
    <div ref={workbench} tabIndex={-1}><WorkflowWorkbench snapshot={snapshot} task={task} cancelled={cancelled} canHandle={canHandle || actions.some(canAct)} onMaterialWork={openMaterial} onOpenInputs={onOpenInputs} shared={workspaceContext.state !== 'local'} reviewState={reviewState} actorId={actor} writable={Boolean(writable && workspaceContext.state === 'connected')} actions={<>
      <span className="my-chip text-my-secondary">{stageLabel}</span>
      {primary && actionButton(primary, !reviewingPrd)}{secondary.map((action) => actionButton(action))}
      {more.length > 0 && <Dropdown align="right" width={170} trigger={({ toggle }) => <Button size="sm" variant="ghost" onClick={toggle} aria-label="更多流程操作"><MoreHorizontal size={16} /></Button>}>{close => more.map((action) => <DropdownItem key={action} disabled={busy || pending} onClick={() => { close(); void invoke(action) }} icon={<span>{action === 'decline' ? <X size={14} /> : action === 'reassign' ? <Users size={14} /> : <FileQuestion size={14} />}</span>}>{WORKFLOW_ACTION_LABELS[action]}</DropdownItem>)}</Dropdown>}
      {closed && (cancelled ? <CircleX size={18} className="text-my-tertiary" aria-label="任务已取消" /> : <CircleCheck size={18} className="text-my-success-text" aria-label="流程已结束" />)}
    </>} /></div>
    {showDevelopment && workspaceContext.state !== 'local' && <TaskPlanningCard key={`${scopeKey}:${actor}:${task.id}:${task.createdAt}`} snapshot={snapshot} task={task} onOwnerChange={occupied => {
      setPlanningOccupied(occupied)
      if (planningOwner.current !== null && planningOwner.current !== occupied) setPlanningOwnerRevision(revision => revision + 1)
      planningOwner.current = occupied
    }} onOpenMaterial={receipt => {
      if (!source.owns()) return
      setMaterialEntry(current => ({ kind: 'implement', mode: 'work', requestId: (current?.requestId ?? 0) + 1, documentId: receipt.documentId, versionId: receipt.versionId ?? undefined }))
      onMaterialCommitted?.()
      requestAnimationFrame(() => { if (source.owns()) materials.current?.scrollIntoView({ block: 'nearest' }) })
    }} />}
    {showDevelopment && <div ref={development} tabIndex={-1}><TaskDevelopmentCard snapshot={snapshot} task={task} resourceRefresh={resourceRefresh} planningOwnerRevision={planningOwnerRevision} openRequest={openDevelopment} onOpenInputs={onOpenInputs} onExecutionChanged={() => setExecutionResultsRevision(revision => revision + 1)} onEnter={enterPlanning} /></div>}
    <TaskExecutionResults key={`${scopeKey}:${actor}:${task.id}:${task.createdAt}`} task={task} refreshRevision={executionResultsRevision} />
    <div ref={materials} className="workflow-stage-materials">
      {workspaceContext.state === 'local' && task.workflow?.stage === 'designing' && <ManualDesignDraft snapshot={snapshot} task={task} openRequest={materialEntry?.requestId ?? 0} disabled={!canHandle || busy || pending} onSubmit={(body) => { if (owns()) setDialog({ action: 'submit_design', stage: task.workflow?.stage, body }) }} />}
      <TaskMaterials snapshot={snapshot} task={task} entryRequest={materialEntry} onReviewState={setReviewState} onCommitted={() => { if (source.owns()) onMaterialCommitted?.() }} />
    </div>
    {error && <div className="collab-inline-error" role="alert">{error}</div>}
    {dialog && <WorkflowActionDialog key={`${scopeKey}:${actor}:${task.id}:${dialog.action}${dialog.plan ? `:${taskInputCanonical(dialog.plan)}` : ''}`} snapshot={snapshot} task={task} action={dialog.action} expectedStage={dialog.stage} initialBody={dialog.body} initialPlan={dialog.plan} onEditPlan={plan => {
      if (!source.owns()) return
      setDialog(null)
      setMaterialEntry(current => ({ kind: 'implement', mode: 'work', requestId: (current?.requestId ?? 0) + 1, documentId: plan.documentId }))
      requestAnimationFrame(() => { if (source.owns()) materials.current?.scrollIntoView({ block: 'nearest' }) })
    }} onClose={() => setDialog(null)} onCompleted={(updated) => completed(dialog.action, updated)} />}
  </section>
}

function WorkflowActionDialog({ snapshot, task, action, expectedStage, initialBody, initialPlan, onEditPlan, onClose, onCompleted }: { snapshot: CruxSnapshot; task: CruxTask; action: CruxTaskAction; expectedStage: CruxTaskStage | undefined; initialBody?: string; initialPlan?: TaskMaterialInputReference; onEditPlan?(plan: TaskMaterialInputReference): void; onClose: () => void; onCompleted: (snapshot: CruxSnapshot) => void }): JSX.Element {
  const { workspaceContext, busy, run } = useCrux()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [identity] = useState(() => ({ sourceKey: taskSourceKey(snapshot, workspaceContext), actor: actorId(snapshot) }))
  const { agents, crews } = availableExecutionTargets(snapshot, task.spaceId)
  const planReference = action === 'approve_plan' ? initialPlan : undefined
  const fixedPlanBody = planReference ? initialBody ?? '' : undefined
  const creationContext = [action, expectedStage, task.workflow?.history.at(-1)?.id]
  const draft = useTaskDraft(snapshot, workspaceContext, { kind: 'workflow', spaceId: task.spaceId, task,
    creationContext: planReference ? [...creationContext, taskInputCanonical(planReference)] : creationContext,
    base: JSON.stringify([task.title, task.description, task.acceptanceCriteria, task.workKind, task.iterationIds, task.assigneeIds, task.executor]) })
  const [body, setBody] = useTaskDraftField(draft, 'body', initialBody ?? '')
  const [recipient, setRecipient] = useTaskDraftField(draft, 'recipient', '')
  const [target, setTarget] = useTaskDraftField(draft, 'target', task.executor ? `${task.executor.kind}:${task.executor.id}` : 'manual')
  const [design, setDesign] = useTaskDraftField<DesignReference | null>(draft, 'design', () => action === 'approve_design' ? taskDesignReference(task) : null)
  const [version, setVersion] = useTaskDraftField(draft, 'version', task.iterationIds[0] ?? '')
  const [nextStage, setNextStage] = useTaskDraftField<'design_ready' | 'dev_ready'>(draft, 'nextStage', 'design_ready')
  const [workKind, setWorkKind] = useTaskDraftField<CruxTaskWorkKind>(draft, 'workKind', task.workKind ?? 'code')
  const [criteria, setCriteria] = useTaskDraftField(draft, 'criteria', (task.acceptanceCriteria ?? []).join('\n'))
  const [checked, setChecked] = useTaskDraftField<string[]>(draft, 'checked', [])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [configuringMembers, setConfiguringMembers] = useState(false)
  const [agentNotice, setAgentNotice] = useState('')
  const [nativeResults, setNativeResults] = useState<ProductTaskResults | null>(null)
  const [codeKind, setCodeKind] = useTaskDraftField<'captured' | 'git-commit'>(draft, 'codeKind', 'captured')
  const [codeBase, setCodeBase] = useTaskDraftField(draft, 'codeBase', '')
  const [codeCommit, setCodeCommit] = useTaskDraftField(draft, 'codeCommit', '')
  useEffect(() => {
    if (action !== 'submit_test' || workspaceContext.state !== 'connected') return
    const client = productTaskApi()
    if (!client?.results) return
    let current = true
    void client.results({ workspaceKey: workspaceContext.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt })
      .then(reply => { if (current && reply.ok) setNativeResults(reply.value) }).catch(() => { /* Submit rechecks the original owner and surfaces failures. */ })
    return () => { current = false }
  }, [action, workspaceContext.key, workspaceContext.state, task.id, task.createdAt])
  const responsibility = action === 'arrange' && workKind !== 'general' ? nextStage === 'design_ready' ? 'design' : 'development' : undefined
  const recipients = workflowRecipients(snapshot, task, action, responsibility, workspaceContext.state === 'local')
  const requiredRole = task.workflow?.deliveryState ? ['submit_test', 'pass_test'].includes(action) && task.workKind !== 'general' ? 'testOwnerId' : action === 'submit_delivery' ? 'acceptanceOwnerId' : undefined : undefined
  const needsRoleMatch = ['approve_design', 'submit_test', 'return_development'].includes(action) || action === 'return_delivery' && task.workKind !== 'general' || Boolean(responsibility)
  const missingRole = needsRoleMatch && !recipients.some((candidate) => candidate.suggested)
  const recipientLabel = action === 'return_delivery' && task.workKind === 'general' ? '负责同事' : recipientRole(action)
  const stageChanged = task.workflow?.stage !== expectedStage
  const assigning = action === 'arrange' || action === 'reassign'
  const owns = (): boolean => {
    const current = useCrux.getState()
    return mounted.current && canInteract() && !interactionSignal?.aborted && Boolean(current.snapshot &&
      taskSourceKey(current.snapshot, current.workspaceContext) === identity.sourceKey && current.openTaskId === task.id &&
      canReadTaskSpace(current.snapshot, current.workspaceContext, task.spaceId) &&
      !current.snapshot.spaces.find((space) => space.id === task.spaceId)?.archived &&
      current.snapshot.tasks.some((item) => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId))
  }
  function selectTarget(value: string): void {
    setTarget(value)
  }
  function suggestArrangementRecipient(stage: 'design_ready' | 'dev_ready', kind: CruxTaskWorkKind): void {
    if (recipient || action !== 'arrange' || kind === 'general') return
    const candidates = workflowRecipients(snapshot, task, action, stage === 'dev_ready' ? 'development' : 'design', workspaceContext.state === 'local')
    const suggestion = candidates.find((candidate) => candidate.suggested)
    if (suggestion) setRecipient(suggestion.member.id)
  }
  async function save(): Promise<void> {
    if (!owns() || useCrux.getState().busy || inFlight.current || creatingAgent || configuringMembers || stageChanged || draft.stale) return
    setError('')
    const handoffBody = fixedPlanBody ?? [body.trim(), design && ['submit_design', 'approve_design'].includes(action) ? designReferenceBody(design) : ''].filter(Boolean).join('\n\n')
    if (BODY_REQUIRED.has(action) && !handoffBody) { setError('请填写本次交接内容，或选择共享设计固定版本'); return }
    if (HANDED.has(action) && !recipients.some((candidate) => candidate.member.id === recipient)) { setError(`请明确选择本空间的${recipientLabel}；原处理人不会自动代收。`); return }
    const acceptance = criteria.split('\n').map((item) => item.trim()).filter(Boolean)
    if (action === 'arrange' && !acceptance.length) { setError('请补充至少一项验收标准'); return }
    if (action === 'pass_test' && (!(task.acceptanceCriteria?.length) || task.acceptanceCriteria.some((criterion) => !checked.includes(criterion)))) { setError('请逐项确认验收标准'); return }
    let executor: CruxExecutorRef | null | undefined
    if (assigning) {
      const [kind, id] = target.split(':')
      const entry = kind === 'agent' ? agents.find((item) => item.id === id) : kind === 'crew' ? crews.find((item) => item.id === id) : undefined
      if (target !== 'manual' && !entry) { setError('原执行配置已不可用，请重新选择。'); return }
      executor = entry && (kind === 'agent' || kind === 'crew') ? { kind, id: entry.id, name: entry.name } : null
    }
    const input: CruxTransitionTaskInput = { taskId: task.id, action, expectedStage, expectedUpdatedAt: task.updatedAt,
      ...(handoffBody ? { body: handoffBody } : action === 'pass_test' ? { body: checked.map((criterion) => `✓ ${criterion}`).join('\n') } : {}),
      ...(HANDED.has(action) && recipient ? { assigneeId: recipient } : {}),
      ...(task.workflow?.deliveryState ? { expectedDeliveryRevision: task.workflow.deliveryState.revision } : {}),
      ...(action === 'arrange' ? { executor, workKind, acceptanceCriteria: acceptance, ...(workKind === 'code' ? { nextStage } : {}), ...(!task.iterationIds.length && version ? { iterationId: version } : {}) } : {}),
      ...(action === 'reassign' ? { executor } : {}),
      ...(action === 'supplement' && !task.acceptanceCriteria?.length && acceptance.length ? { acceptanceCriteria: acceptance } : {}),
      ...(action === 'pass_test' ? { checkedCriteria: checked } : {}) }
    inFlight.current = true
    setSubmitting(true)
    const acknowledge = draft.acknowledge()
    try {
      const result = await run(WORKFLOW_ACTION_LABELS[action], async () => {
        if (!owns()) return { ok: false as const, error: '原任务来源已不可操作，请重新打开。' }
        if (action === 'approve_plan' && workspaceContext.state === 'connected') {
          const bridge = api.cruxGovernance
          if (!bridge) return { ok: false as const, error: '当前客户端无法核对原技术方案。' }
          const query = { workspaceKey: workspaceContext.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }
          const inputs = await bridge.inputs(query)
          if (!owns()) return { ok: false as const, error: '原任务来源已变化。' }
          if (!inputs.ok) return { ok: false as const, error: inputs.error }
          const plans = inputs.value.current?.documents.filter(reference => reference.kind === 'implement') ?? []
          if (planReference) {
            if (plans.length !== 1 || taskInputCanonical(plans[0]) !== taskInputCanonical(planReference)) return { ok: false as const, error: '已采用的技术方案版本已变化，请关闭后重新核对。' }
            const document = await bridge.readDocument({ ...query, reference: planReference })
            if (!owns()) return { ok: false as const, error: '原任务来源已变化。' }
            if (!document.ok) return { ok: false as const, error: document.error }
            if (taskInputCanonical(document.value.reference) !== taskInputCanonical(planReference) || document.value.text !== fixedPlanBody) return { ok: false as const, error: '原技术方案固定版本或正文无法核对。' }
            input.body = document.value.text
          } else if (plans.length) return { ok: false as const, error: '任务已采用技术方案，请关闭后确认该固定版本。' }
        }
        if (design && ['submit_design', 'approve_design'].includes(action)) {
          const bridge = api && Object.hasOwn(api, 'cruxMaterials') ? api.cruxMaterials : undefined
          if (!bridge) return { ok: false as const, error: '当前客户端无法核对设计材料，草稿已保留。' }
          const result = await bridge.read({ workspaceKey: workspaceContext.key, taskId: task.id, taskCreatedAt: task.createdAt, spaceId: task.spaceId, documentId: design.documentId, versionId: design.versionId })
          if (!owns()) return { ok: false as const, error: '原任务来源已不可操作，请重新打开。' }
          if (!result.ok) return { ok: false as const, error: result.error }
          if (!matchesDesignReference(result.value, task, design) || result.value.epoch !== workspaceContext.epoch) return { ok: false as const, error: '原设计版本无法核对，请重新选择。' }
          if (action === 'approve_design' && (result.value.document.approved?.versionId !== design.versionId || result.value.document.approved.bodyDigest !== design.bodyDigest)) return { ok: false as const, error: '请先在共享材料中批准此固定设计版本，再确认开发交接。' }
          input.body = [body.trim(), `共享设计：${result.value.selected.title} · v${result.value.selected.number}`, designReferenceBody(design)].filter(Boolean).join('\n\n')
        }
        if (action === 'submit_test' && workspaceContext.state === 'connected') {
          const native = productTaskApi()
          if (!native?.finish) return { ok: false as const, error: '当前客户端无法核对原执行交付，请更新后重试。' }
          if (codeKind === 'git-commit' && (!nativeResults?.repositoryId || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(codeBase.trim()) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(codeCommit.trim()))) return { ok: false as const, error: '请填写代码基线与交付提交的完整对象编号。' }
          const result = await native.finish({ workspaceKey: workspaceContext.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt,
            ...(codeKind === 'git-commit' && nativeResults?.repositoryId ? { code: { kind: 'git-commit' as const, repositoryId: nativeResults.repositoryId, base: codeBase.trim(), commit: codeCommit.trim() } } : {}) })
          if (!owns()) return { ok: false as const, error: '原任务来源已变化，请重新打开。' }
          if (!result.ok) return { ok: false as const, error: result.error }
        }
        const result = await api.crux.transitionTask(input)
        if (result.ok) acknowledge()
        return result
      })
      if (!owns()) return
      if (result?.ok) onCompleted(result.data)
      else setError(result && !result.ok ? result.error : '操作尚未完成，请核对结果后重试')
    }
    catch (cause) { if (owns()) setError(cause instanceof Error ? cause.message : '交接失败') }
    finally { inFlight.current = false; if (mounted.current) setSubmitting(false) }
  }
  return <Modal open onClose={onClose} width={560} ariaLabel={WORKFLOW_ACTION_LABELS[action]} placement="center"><div className="collab-flow-dialog-header"><h2>{action === 'arrange' && task.triagePending ? '接纳并安排' : WORKFLOW_ACTION_LABELS[action]}</h2><Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭交接"><X size={16} /></Button></div>
    <div className="collab-flow-dialog-body my-scrollbar"><fieldset disabled={busy || submitting || stageChanged} className="flex min-w-0 flex-col gap-4">
      {assigning && <div className="space-y-3"><Field label="执行配置"><Select className="w-full" value={target} onChange={(val) => selectTarget(val)} options={[{ value: 'manual', label: '人工处理' }, ...(target !== 'manual' && ![...agents.map((item) => `agent:${item.id}`), ...crews.map((item) => `crew:${item.id}`)].includes(target) ? [{ value: target, label: '原执行配置已不可用，请重新选择', disabled: true }] : []), ...crews.map((crew) => ({ value: `crew:${crew.id}`, label: `小队 · ${crew.name}` })), ...agents.map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.name}` }))] } /></Field>
        <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 text-my-xs text-my-tertiary">{agents.length ? '此处保存执行配置；实际启动需在工作区确认。' : '本空间暂无可独立指派的 Agent，可先创建。'}</p><Button size="sm" variant="outline" disabled={busy || submitting} onClick={() => setCreatingAgent((value) => !value)}>新建空间 Agent</Button></div>
        {agentNotice && <p role="status" className="text-my-xs text-my-secondary">{agentNotice}</p>}
        {creatingAgent && <WorkflowAgentSetup snapshot={snapshot} task={task} onClose={() => setCreatingAgent(false)} onCreated={(id) => { if (owns()) { setTarget(`agent:${id}`); setCreatingAgent(false); setAgentNotice('空间 Agent 已创建并选用；交接草稿已保留。') } }} />}
      </div>}
      {action === 'arrange' && <>
        <div className="grid grid-cols-2 gap-3"><Field label="工作内容"><Select className="w-full" value={workKind} onChange={(val) => { const kind = val === 'general' ? 'general' : 'code'; setWorkKind(kind); suggestArrangementRecipient(nextStage, kind) }} options={[{ value: 'code', label: '研发工作' }, { value: 'general', label: '日常工作' }]} /></Field>{workKind === 'code' && <Field label="下一步"><Select className="w-full" value={nextStage} onChange={(val) => { const stage = val === 'dev_ready' ? 'dev_ready' : 'design_ready'; setNextStage(stage); suggestArrangementRecipient(stage, workKind) }} options={[{ value: 'design_ready', label: '先做设计' }, { value: 'dev_ready', label: '直接开发' }]} /></Field>}</div>
        {!task.iterationIds.length && <Field label="版本（选填）"><Select className="w-full" value={version} onChange={(val) => setVersion(val)} options={[{ value: '', label: '未排期' }, ...snapshot.iterations.filter((item) => item.spaceId === task.spaceId && item.status !== 'completed').map((item) => ({ value: item.id, label: item.name }))]} /></Field>}
        <Field label="验收标准"><textarea className={textareaClass} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一项" /></Field></>}
      {action === 'pass_test' && <div className="flex flex-col gap-3">{(task.acceptanceCriteria ?? []).map((criterion) => <label key={criterion} className="flex items-start gap-2 text-my-sm"><input type="checkbox" className="mt-0.5" checked={checked.includes(criterion)} onChange={(event) => setChecked((previous) => event.target.checked ? [...previous, criterion] : previous.filter((item) => item !== criterion))} /><span>{criterion}</span></label>)}</div>}
      {['submit_design', 'approve_design'].includes(action) && <DesignRevisionPicker task={task} purpose={action === 'approve_design' ? 'approve' : 'submit'} value={design} onChange={setDesign} disabled={submitting || busy} />}
      {planReference ? <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><span className="my-item-title min-w-0 flex-1 break-words">{planReference.title}</span>{onEditPlan && <Button size="sm" variant="ghost" onClick={() => { if (owns()) onEditPlan(planReference) }}><Pencil size={13} />修改材料</Button>}</div>
        <div aria-label="已采用的技术方案" className="my-scrollbar max-h-72 overflow-auto"><TeamMarkdown text={fixedPlanBody ?? ''} identity={`${planReference.documentId}:${planReference.versionId}:${planReference.bodyDigest}`} /></div>
      </div> : BODY_LABELS[action] && <Field label={BODY_LABELS[action] ?? '交接说明'}><textarea autoFocus className={textareaClass} rows={action === 'submit_design' ? 8 : 4} placeholder={action === 'submit_design' ? '可直接编写设计方案、关键交互与评审重点，或关联上方共享设计版本。' : undefined} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save() } }} /></Field>}
      {action === 'submit_test' && nativeResults?.canFinish && !nativeResults.checkpoint && <div className="space-y-3">
        <Field label="交付代码"><Select className="w-full" value={codeKind} onChange={(val) => setCodeKind(val === 'git-commit' ? 'git-commit' : 'captured')} options={[{ value: 'captured', label: '本次捕获的工程文件' }, { value: 'git-commit', label: '已核实的 Git 提交' }]} /></Field>
        {codeKind === 'git-commit' && <><Field label="代码基线"><input className={inputClass} value={codeBase} onChange={event => setCodeBase(event.target.value)} placeholder="完整对象编号" /></Field><Field label="交付提交"><input className={inputClass} value={codeCommit} onChange={event => setCodeCommit(event.target.value)} placeholder="完整对象编号" /></Field></>}
      </div>}
      {action === 'supplement' && !task.acceptanceCriteria?.length && <Field label="验收标准"><textarea className={textareaClass} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一项" /></Field>}
      {HANDED.has(action) && <Field label={action === 'arrange' ? workKind === 'general' ? '负责同事' : nextStage === 'design_ready' ? '设计负责人' : '开发负责人' : recipientLabel}><Select className="w-full" value={recipient} onChange={(val) => setRecipient(val)} options={[{ value: '', label: '请选择空间成员' }, ...(recipient && !recipients.some((candidate) => candidate.member.id === recipient) ? [{ value: recipient, label: '原处理人已不可选，请重新选择', disabled: true }] : []), ...recipients.map(({ member, reason }) => ({ value: member.id, label: `${member.name}${member.id === identity.actor ? '（自己）' : ''} · ${reason}` }))]} /><p className="mt-1 text-my-xs text-my-tertiary">{!recipients.length ? '暂无符合条件的空间成员，请由空间管理员补充成员或指定负责人。' : recipient ? recipients.find((candidate) => candidate.member.id === recipient)?.reason ?? '请重新核对接收人。' : '负责同事接收任务并确认交接；Agent 只作为执行配置。'}</p></Field>}
      {HANDED.has(action) && <div className="space-y-3">{requiredRole && !recipients.length ? <p role="status" className="text-my-xs text-my-warning-text">此任务尚无可接收交付的指定{requiredRole === 'testOwnerId' ? '测试' : '验收'}负责人，请先核对空间成员与任务职责。</p> : missingRole && <p role="status" className="text-my-xs text-my-warning-text">未找到{responsibility === 'design' ? '设计' : action === 'submit_test' ? '测试' : '开发'}职责匹配的空间成员。可添加同事，或明确指定本空间成员负责本次工作。</p>}<Button size="sm" variant="outline" onClick={() => setConfiguringMembers((value) => !value)}>{requiredRole ? '配置任务交付负责人' : workspaceContext.canManage ? '添加空间成员' : '查看空间成员'}</Button>{configuringMembers && <WorkflowSpaceMembers snapshot={snapshot} task={task} requiredRole={requiredRole} onClose={() => setConfiguringMembers(false)} />}</div>}
    </fieldset>{draft.stale && <div role="alert" className="collab-inline-error"><span>任务内容已更新，草稿已保留。</span><details className="w-full"><summary>查看当前任务</summary><p className="whitespace-pre-wrap break-words">{task.title}{task.description ? `\n${task.description}` : ''}</p><ul className="list-disc pl-4">{task.acceptanceCriteria?.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></details><Button size="sm" disabled={busy || submitting || stageChanged} onClick={() => { if (owns()) draft.review() }}>已核对，继续编辑</Button></div>}{stageChanged && <div role="alert" className="collab-inline-error">任务阶段已更新，请关闭后核对当前进度。</div>}{error && <div role="alert" className="collab-inline-error">{error}</div>}</div>
    <footer className="collab-flow-dialog-footer">{draft.hasDraft && <Button variant="ghost" className="mr-auto" disabled={busy || submitting} onClick={() => { if (owns()) { draft.discard(); onClose() } }}>放弃草稿</Button>}<Button variant="outline" onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || submitting || creatingAgent || configuringMembers || stageChanged || draft.stale} onClick={() => void save()}>{submitting && <Loader2 size={14} className="animate-spin" />}{action === 'arrange' ? '确认安排' : action === 'reassign' ? '确认转交' : WORKFLOW_ACTION_LABELS[action]}</Button></footer>
  </Modal>
}
