import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowRight, ArrowUpRight, Check, CheckCheck, CircleCheck, CircleX, ClipboardCheck, Code2, FileQuestion, FileText, GitBranch, Loader2, MoreHorizontal, Palette, Pencil, Play, RotateCcw, Send, ShieldCheck, Users, X, type LucideIcon } from 'lucide-react'
import type { HifoxExecutorRef, HifoxSnapshot, HifoxTask, HifoxTaskAction, HifoxTaskStage, HifoxTaskWorkKind, HifoxTransitionTaskInput } from '@shared/hifox'
import type { HifoxWorkLocal, HifoxWorkResult } from '@shared/hifox-work'
import { getHifoxTaskActions, getHifoxTaskStageMetadata, isHifoxTriageManager } from '@shared/hifox-domain/workflow'
import { api } from '../api'
import { confirmDialog } from '../components/Dialogs'
import { Button, Dropdown, DropdownItem, Modal, Tooltip } from '../my/ui'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { availableExecutionTargets, memberOf, useHifox } from './store'
import { Field, inputClass, MemberChip, textareaClass } from './ui'
import { hasLocalWorkBridge, openLocalWork } from './local-work'
import { canReadTaskSpace, taskSourceKey } from './pages/task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './pages/task-detail/task-drafts'

export const WORKFLOW_ACTION_LABELS: Record<HifoxTaskAction, string> = {
  accept: '先接纳', arrange: '安排处理', request_info: '请补充', supplement: '补充信息', decline: '不采纳',
  start_design: '开始设计', submit_design: '提交设计评审', approve_design: '确认设计并交给开发', return_design: '退回设计',
  begin_development: '开始处理', approve_plan: '确认技术方案', submit_test: '交给测试', return_development: '退回开发',
  pass_test: '测试通过', accept_delivery: '验收通过', return_delivery: '未满足需求', submit_delivery: '提交交付成果', reassign: '转交'
}
const ACTION_ICONS: Record<HifoxTaskAction, LucideIcon> = {
  accept: Check, arrange: Users, request_info: FileQuestion, supplement: Pencil, decline: X,
  start_design: Palette, submit_design: Send, approve_design: CheckCheck, return_design: RotateCcw,
  begin_development: Play, approve_plan: ClipboardCheck, submit_test: Send, return_development: RotateCcw,
  pass_test: ShieldCheck, accept_delivery: CheckCheck, return_delivery: RotateCcw, submit_delivery: Send, reassign: Users
}
const BODY_LABELS: Partial<Record<HifoxTaskAction, string>> = {
  request_info: '需要补充的内容', supplement: '补充说明', decline: '不采纳原因', submit_design: '设计稿链接或交付说明',
  approve_design: '交接说明（选填）', return_design: '调整意见', approve_plan: '实现方案与检查范围',
  submit_test: '改动说明与检查结果', return_development: '复现步骤、实际结果与预期', pass_test: '测试记录（选填）',
  accept_delivery: '验收说明（选填）', return_delivery: '未满足的验收点', submit_delivery: '产出链接或交付说明', reassign: '交接说明（选填）'
}
const BODY_REQUIRED = new Set<HifoxTaskAction>(['request_info', 'supplement', 'decline', 'submit_design', 'return_design', 'approve_plan', 'submit_test', 'return_development', 'return_delivery', 'submit_delivery'])
const HANDED = new Set<HifoxTaskAction>(['arrange', 'reassign', 'submit_design', 'approve_design', 'return_design', 'submit_test', 'return_development', 'pass_test', 'return_delivery', 'submit_delivery'])

function actorId(snapshot: HifoxSnapshot): string | null {
  const context = useHifox.getState().workspaceContext
  return context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id ?? null : null)
}

/** Job titles only suggest an editable recipient; authorization always uses real membership. */
function suggestedHandler(snapshot: HifoxSnapshot, task: HifoxTask, action: HifoxTaskAction, actor: string): string {
  const people = snapshot.members.filter((person) => snapshot.spaces.find((space) => space.id === task.spaceId)?.memberIds.includes(person.id))
  const history = task.workflow?.history ?? []
  const priorAction: Partial<Record<HifoxTaskAction, HifoxTaskAction>> = { return_design: 'start_design', return_development: 'begin_development', return_delivery: 'begin_development', submit_design: 'accept', pass_test: 'accept', submit_delivery: 'accept' }
  const previous = history.slice().reverse().find((event) => event.action === priorAction[action])?.actorId
  if (previous && people.some((person) => person.id === previous)) return previous
  if (['submit_design', 'pass_test', 'submit_delivery'].includes(action) && people.some((person) => person.id === task.creatorId)) return task.creatorId
  const pattern = action === 'submit_test' ? /测试|\bqa\b|test/i : ['approve_design', 'return_development', 'return_delivery'].includes(action) ? /开发|研发|工程|前端|后端|developer|engineer/i : null
  const crew = task.executor?.kind === 'crew' ? snapshot.crews.find((item) => item.id === task.executor?.id) : undefined
  const withinCrew = crew ? people.filter((person) => crew.members.some((member) => member.kind === 'member' && member.id === person.id)) : people
  const suggested = pattern ? withinCrew.find((person) => pattern.test(person.title ?? '')) : undefined
  return suggested?.id ?? (crew?.captain.kind === 'member' ? crew.captain.id : crew?.ownerId) ?? task.workflow?.handlerId ?? task.assigneeIds[0] ?? actor
}

function WorkflowRail({ task, cancelled }: { task: HifoxTask; cancelled: boolean }): JSX.Element {
  const stage = task.workflow?.stage
  const current = task.triagePending ? 0 : !stage || ['accepted', 'needs_info'].includes(stage) ? 0 : ['design_ready', 'designing', 'design_review'].includes(stage) ? 1 : ['dev_ready', 'planning', 'developing'].includes(stage) ? 2 : stage === 'testing' ? 3 : 4
  const steps = (task.workKind === 'general'
    ? [{ label: '接纳', icon: FileText, index: 0 }, { label: '处理', icon: Pencil, index: 2 }, { label: '验收', icon: ShieldCheck, index: 4 }]
    : [{ label: '接纳', icon: FileText, index: 0 }, { label: '设计', icon: Palette, index: 1 }, { label: '开发', icon: Code2, index: 2 }, { label: '测试', icon: ClipboardCheck, index: 3 }, { label: '验收', icon: ShieldCheck, index: 4 }]).filter((step) => step.index !== 1 || !task.workflow?.history.some((event) => event.action === 'arrange' && event.toStage === 'dev_ready'))
  return <ol className="collab-stage-rail" aria-label="任务交接阶段">{steps.map(({ label, icon: Icon, index }, i) => <li key={label} data-state={cancelled ? 'cancelled' : index < current || stage === 'done' ? 'complete' : index === current ? 'current' : 'upcoming'} aria-current={!cancelled && index === current ? 'step' : undefined}><span className="collab-stage-icon">{cancelled ? <X size={14} /> : index < current || stage === 'done' ? <Check size={14} /> : <Icon size={14} />}</span><span>{label}</span>{i < steps.length - 1 && <ArrowRight size={12} className="collab-stage-arrow" aria-hidden="true" />}</li>)}</ol>
}

interface LocalTaskBinding {
  updatedAt: string
  local: HifoxWorkLocal | null
  feedback?: { kind: 'review' | 'error'; message: string; review?: HifoxWorkLocal }
}

export function TaskWorkflow({ snapshot, task }: { snapshot: HifoxSnapshot; task: HifoxTask }): JSX.Element {
  const { workspaceContext, busy, run } = useHifox()
  const actor = actorId(snapshot)
  const [dialog, setDialog] = useState<{ action: HifoxTaskAction; stage: HifoxTaskStage | undefined } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [binding, setBinding] = useState<LocalTaskBinding | null>(null)
  const [bindingRefresh, setBindingRefresh] = useState(0)
  const knownBinding = useRef(false)
  const [review, setReview] = useState<HifoxWorkLocal | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const scopeKey = workspaceContext.key
  const sourceKey = taskSourceKey(snapshot, workspaceContext)
  const handler = task.workflow?.handlerId ?? task.assigneeIds[0]
  const owns = (): boolean => {
    const current = useHifox.getState()
    return mounted.current && canInteract() && !interactionSignal?.aborted && Boolean(current.snapshot &&
      taskSourceKey(current.snapshot, current.workspaceContext) === sourceKey && current.openTaskId === task.id &&
      canReadTaskSpace(current.snapshot, current.workspaceContext, task.spaceId) &&
      !current.snapshot.spaces.find((space) => space.id === task.spaceId)?.archived &&
      current.snapshot.tasks.some((item) => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId &&
        item.workKind === task.workKind && (item.workflow?.handlerId ?? item.assigneeIds[0]) === handler))
  }
  const canHandle = Boolean(actor && (handler === actor || ((task.triagePending || !task.workflow || task.workflow.stage === 'accepted') && (task.creatorId === actor || isHifoxTriageManager(snapshot, task.spaceId, actor)))))
  const canTransfer = Boolean(actor && isHifoxTriageManager(snapshot, task.spaceId, actor))
  const canInspectBinding = Boolean(canHandle && handler === actor && task.workKind === 'code' && hasLocalWorkBridge())
  const hasBegunDevelopment = Boolean(task.workflow && (['planning', 'developing', 'testing', 'acceptance', 'done'].includes(task.workflow.stage) || task.workflow.history.some((event) => event.action === 'begin_development')))
  const shouldReadBinding = canInspectBinding && !task.triagePending && (task.workflow?.stage === 'dev_ready' || hasBegunDevelopment)
  const currentBinding = canInspectBinding && binding?.updatedAt === task.updatedAt ? binding : null
  const local = currentBinding?.local
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    const ticket = ++generation.current
    const live = (): boolean => {
      const current = useHifox.getState().snapshot?.tasks.find((item) => item.id === task.id)
      return active && ticket === generation.current && owns() && current?.updatedAt === task.updatedAt &&
        current.workKind === 'code' && (current.workflow?.handlerId ?? current.assigneeIds[0]) === actor
    }
    if (!shouldReadBinding) {
      knownBinding.current = false
      setBinding(null)
      setReview(null)
    } else if (canInteract() && api.hifoxWork) {
      const expected = hasBegunDevelopment || knownBinding.current
      void api.hifoxWork.status({ workspaceKey: scopeKey, taskId: task.id }).then((reply) => {
        if (!live()) return
        if (!reply.ok) {
          setBinding({ updatedAt: task.updatedAt, local: null, ...(reply.reason === 'cancelled' ? {} : {
            feedback: reply.local && reply.reviewRequired
              ? { kind: 'review' as const, message: reply.error, review: reply.local }
              : { kind: 'error' as const, message: reply.error }
          }) })
        } else if (reply.prepared) {
          knownBinding.current = true
          setBinding({ updatedAt: task.updatedAt, local: reply.local, ...(reply.reviewRequired ? {
            feedback: { kind: 'review' as const, message: '任务材料已更新，请审阅本机材料。', review: reply.local }
          } : {}) })
        } else setBinding({ updatedAt: task.updatedAt, local: null, ...(expected ? {
          feedback: { kind: 'error' as const, message: '未找到原本机任务绑定，请核对后重试。' }
        } : {}) })
      }).catch((cause: unknown) => {
        if (live()) setBinding({ updatedAt: task.updatedAt, local: null, feedback: { kind: 'error', message: cause instanceof Error ? cause.message : '本机任务绑定暂时无法核对，请重试。' } })
      })
    }
    return () => { active = false; generation.current++ }
  }, [sourceKey, task.id, task.updatedAt, shouldReadBinding, hasBegunDevelopment, actor, bindingRefresh, interactionSignal])
  async function enterPlanning(prepared: HifoxWorkLocal): Promise<void> {
    if (!owns()) return
    const result = await run('开始处理', async () => owns()
      ? api.hifox.transitionTask({ taskId: task.id, action: 'begin_development', expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt })
      : { ok: false as const, error: '原任务来源已不可操作，请重新打开。' })
    if (!owns()) return
    if (!result?.ok) { setError(result && !result.ok ? result.error : '操作尚未完成，请核对任务后重试'); return }
    knownBinding.current = true
    setBinding({ updatedAt: useHifox.getState().snapshot?.tasks.find((item) => item.id === task.id)?.updatedAt ?? task.updatedAt, local: prepared })
    setError(''); setReview(null)
    await openLocalWork(scopeKey, task.id, prepared)
  }
  async function begin(): Promise<void> {
    if (!owns() || inFlight.current || useHifox.getState().busy || !api.hifoxWork || !hasLocalWorkBridge()) return
    if (!task.acceptanceCriteria?.length) { setError('请先补充验收标准'); return }
    inFlight.current = true
    setPending(true); setError(''); setReview(null); setBinding(null)
    try {
      const reply: HifoxWorkResult = await api.hifoxWork.prepare({ workspaceKey: scopeKey, taskId: task.id })
      if (!owns()) return
      if (!reply.ok) { if (reply.reason === 'cancelled') return; setError(reply.error); if (reply.local && ['source_changed', 'prd_conflict'].includes(reply.reason)) setReview(reply.local); return }
      if (reply.prepared && reply.reviewRequired) { setError('任务材料已更新，请先核对已有开发计划'); setReview(reply.local); return }
      if (reply.prepared) await enterPlanning(reply.local)
      else setError('开发上下文尚未准备完成')
    } catch (cause) { if (owns()) setError(cause instanceof Error ? cause.message : '开发上下文准备失败') }
    finally { inFlight.current = false; if (mounted.current) setPending(false) }
  }
  async function invoke(action: HifoxTaskAction): Promise<void> {
    if (!owns() || inFlight.current || useHifox.getState().busy) return
    if (action === 'begin_development') { await begin(); return }
    if (action === 'start_design' || action === 'accept') {
      inFlight.current = true
      setPending(true); setError('')
      try {
        const result = await run(WORKFLOW_ACTION_LABELS[action], async () => owns()
          ? api.hifox.transitionTask({ taskId: task.id, action, expectedStage: task.workflow?.stage, expectedUpdatedAt: task.updatedAt })
          : { ok: false as const, error: '原任务来源已不可操作，请重新打开。' })
        if (owns() && !result?.ok) setError(result && !result.ok ? result.error : '操作未完成')
      } finally { inFlight.current = false; if (mounted.current) setPending(false) }
      return
    }
    setDialog({ action, stage: task.workflow?.stage })
  }
  const cancelled = snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category === 'cancelled'
  const closed = cancelled || snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category === 'done'
  const actions = !closed ? getHifoxTaskActions(task) : []
  const primary = task.triagePending && actions.includes('arrange') ? 'arrange' : actions.find((action) => !['request_info', 'decline', 'return_design', 'return_development', 'return_delivery', 'reassign'].includes(action))
  const secondary = actions.filter((action) => action !== primary && !['request_info', 'decline', 'reassign'].includes(action))
  const more = actions.filter((action) => ['request_info', 'decline', 'reassign'].includes(action) && (canHandle || canTransfer && action === 'reassign'))
  function actionButton(action: HifoxTaskAction, primaryAction = false): JSX.Element {
    const Icon = ACTION_ICONS[action]
    const unavailable = action === 'begin_development' && !hasLocalWorkBridge()
    const label = action === 'arrange' && task.triagePending ? '接纳并安排' : WORKFLOW_ACTION_LABELS[action]
    return <Tooltip key={action} label={unavailable ? '代码工作需要桌面端的本机项目' : label} side="bottom"><Button variant={primaryAction ? 'primary' : 'outline'} size="sm" disabled={pending || busy || unavailable} onClick={() => void invoke(action)}>{pending && primaryAction ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}{unavailable ? '桌面端处理' : label}</Button></Tooltip>
  }
  return <section className="collab-task-workflow" aria-label="任务流程"><WorkflowRail task={task} cancelled={cancelled} />
    <div className="collab-task-actionbar"><span className="my-chip text-my-secondary">{cancelled ? '已取消' : task.triagePending ? '待分拣' : task.workflow ? getHifoxTaskStageMetadata(task.workflow.stage).label : '原有工作流'}</span>{handler && <MemberChip member={memberOf(snapshot, handler)} />}<span className="flex-1" />
      {canHandle && primary && actionButton(primary, true)}{canHandle && secondary.map((action) => actionButton(action))}
      {more.length > 0 && <Dropdown align="right" width={170} trigger={({ toggle }) => <Button size="sm" variant="ghost" onClick={toggle} aria-label="更多流程操作"><MoreHorizontal size={16} /></Button>}>{close => more.map((action) => <DropdownItem key={action} disabled={busy || pending} onClick={() => { close(); void invoke(action) }} icon={<span>{action === 'decline' ? <X size={14} /> : action === 'reassign' ? <Users size={14} /> : <FileQuestion size={14} />}</span>}>{WORKFLOW_ACTION_LABELS[action]}</DropdownItem>)}</Dropdown>}
      {closed && (cancelled ? <CircleX size={18} className="text-my-tertiary" aria-label="任务已取消" /> : <CircleCheck size={18} className="text-my-success-text" aria-label="流程已结束" />)}
    </div>
    {local && !currentBinding?.feedback && <button type="button" className="collab-local-task" onClick={() => { if (owns() && canInspectBinding) void openLocalWork(scopeKey, task.id, local).catch((cause: unknown) => { if (owns()) setError(cause instanceof Error ? cause.message : '打开开发任务失败') }) }}><GitBranch size={14} /><span>{local.taskId}</span><span className="text-my-tertiary">Trellis</span><ArrowUpRight size={13} /></button>}
    {currentBinding?.feedback && <div role={currentBinding.feedback.kind === 'review' ? 'status' : 'alert'} className={currentBinding.feedback.kind === 'review' ? 'mt-3 flex flex-wrap items-center gap-2 rounded-my-md bg-my-warning-subtle p-2 text-my-xs text-my-warning-text' : 'collab-inline-error'} aria-label="本机任务绑定"><span className="min-w-0 flex-1">{currentBinding.feedback.message}</span>{currentBinding.feedback.review && <Button size="sm" variant="outline" onClick={() => { const target = currentBinding.feedback?.review; if (target && owns() && canInspectBinding) void openLocalWork(scopeKey, task.id, target).catch((cause: unknown) => { if (owns()) setError(cause instanceof Error ? cause.message : '打开材料失败') }) }}>审阅材料</Button>}<Button size="sm" variant="ghost" onClick={() => { if (owns()) setBindingRefresh((value) => value + 1) }}>重新核对</Button></div>}
    {error && <div className="collab-inline-error" role="alert"><span className="min-w-0 flex-1">{error}</span>{review && canInspectBinding && <><Button size="sm" onClick={() => { if (owns()) void openLocalWork(scopeKey, task.id, review).catch((cause: unknown) => { if (owns()) setError(cause instanceof Error ? cause.message : '打开失败') }) }}>审阅材料</Button>{task.workflow?.stage === 'dev_ready' && <Button size="sm" disabled={pending || busy} onClick={() => void confirmDialog({ title: '沿用本机材料继续？', message: '已有修改会保留，请在开发计划中核对当前需求。', confirmText: '继续规划' }, interactionSignal).then(async (confirmed) => { if (confirmed && owns() && !inFlight.current && !useHifox.getState().busy) { inFlight.current = true; setPending(true); try { await enterPlanning(review) } catch (cause) { if (owns()) setError(cause instanceof Error ? cause.message : '进入规划失败') } finally { inFlight.current = false; if (mounted.current) setPending(false) } } })}>沿用并继续</Button>}</>}</div>}
    {dialog && <WorkflowActionDialog key={`${scopeKey}:${actor}:${task.id}:${dialog.action}`} snapshot={snapshot} task={task} action={dialog.action} expectedStage={dialog.stage} onClose={() => setDialog(null)} />}
  </section>
}

function WorkflowActionDialog({ snapshot, task, action, expectedStage, onClose }: { snapshot: HifoxSnapshot; task: HifoxTask; action: HifoxTaskAction; expectedStage: HifoxTaskStage | undefined; onClose: () => void }): JSX.Element {
  const { workspaceContext, busy, run } = useHifox()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [identity] = useState(() => ({ sourceKey: taskSourceKey(snapshot, workspaceContext), actor: actorId(snapshot) }))
  const members = snapshot.members.filter((person) => snapshot.spaces.find((space) => space.id === task.spaceId)?.memberIds.includes(person.id))
  const { agents, crews } = availableExecutionTargets(snapshot, task.spaceId)
  const draft = useTaskDraft(snapshot, workspaceContext, { kind: 'workflow', spaceId: task.spaceId, task,
    creationContext: [action, expectedStage, task.workflow?.history.at(-1)?.id],
    base: JSON.stringify([task.title, task.description, task.acceptanceCriteria, task.workKind, task.iterationIds, task.assigneeIds, task.executor]) })
  const [body, setBody] = useTaskDraftField(draft, 'body', '')
  const [recipient, setRecipient] = useTaskDraftField(draft, 'recipient', () => suggestedHandler(snapshot, task, action, identity.actor ?? ''))
  const [target, setTarget] = useTaskDraftField(draft, 'target', task.executor ? `${task.executor.kind}:${task.executor.id}` : `member:${task.assigneeIds[0] ?? identity.actor ?? ''}`)
  const [version, setVersion] = useTaskDraftField(draft, 'version', task.iterationIds[0] ?? '')
  const [nextStage, setNextStage] = useTaskDraftField<'design_ready' | 'dev_ready'>(draft, 'nextStage', 'design_ready')
  const [workKind, setWorkKind] = useTaskDraftField<HifoxTaskWorkKind>(draft, 'workKind', task.workKind ?? 'code')
  const [criteria, setCriteria] = useTaskDraftField(draft, 'criteria', (task.acceptanceCriteria ?? []).join('\n'))
  const [checked, setChecked] = useTaskDraftField<string[]>(draft, 'checked', [])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const stageChanged = task.workflow?.stage !== expectedStage
  const assigning = action === 'arrange' || action === 'reassign'
  const owns = (): boolean => {
    const current = useHifox.getState()
    return mounted.current && canInteract() && !interactionSignal?.aborted && Boolean(current.snapshot &&
      taskSourceKey(current.snapshot, current.workspaceContext) === identity.sourceKey && current.openTaskId === task.id &&
      canReadTaskSpace(current.snapshot, current.workspaceContext, task.spaceId) &&
      !current.snapshot.spaces.find((space) => space.id === task.spaceId)?.archived &&
      current.snapshot.tasks.some((item) => item.id === task.id && item.createdAt === task.createdAt && item.spaceId === task.spaceId))
  }
  function selectTarget(value: string): void {
    setTarget(value)
    const [kind, id] = value.split(':')
    if (kind === 'member') setRecipient(id)
    if (kind === 'crew') { const crew = crews.find((item) => item.id === id); const leader = crew?.captain.kind === 'member' ? crew.captain.id : crew?.ownerId; if (leader) setRecipient(leader) }
  }
  async function save(): Promise<void> {
    if (!owns() || useHifox.getState().busy || inFlight.current || stageChanged || draft.stale) return
    setError('')
    if (BODY_REQUIRED.has(action) && !body.trim()) { setError('请填写本次交接内容'); return }
    const acceptance = criteria.split('\n').map((item) => item.trim()).filter(Boolean)
    if (action === 'arrange' && !acceptance.length) { setError('请补充至少一项验收标准'); return }
    if (action === 'pass_test' && (!(task.acceptanceCriteria?.length) || task.acceptanceCriteria.some((criterion) => !checked.includes(criterion)))) { setError('请逐项确认验收标准'); return }
    let executor: HifoxExecutorRef | null | undefined
    if (assigning) {
      const [kind, id] = target.split(':')
      const entry = kind === 'agent' ? agents.find((item) => item.id === id) : kind === 'crew' ? crews.find((item) => item.id === id) : undefined
      if (kind === 'member' ? !members.some((member) => member.id === id) : !entry) { setError('原分工已不可用，请重新选择。'); return }
      executor = entry && (kind === 'agent' || kind === 'crew') ? { kind, id: entry.id, name: entry.name } : null
    }
    const input: HifoxTransitionTaskInput = { taskId: task.id, action, expectedStage, expectedUpdatedAt: task.updatedAt,
      ...(body.trim() ? { body: body.trim() } : action === 'pass_test' ? { body: checked.map((criterion) => `✓ ${criterion}`).join('\n') } : {}),
      ...(HANDED.has(action) && recipient ? { assigneeId: recipient } : {}),
      ...(action === 'arrange' ? { executor, workKind, acceptanceCriteria: acceptance, ...(workKind === 'code' ? { nextStage } : {}), ...(!task.iterationIds.length && version ? { iterationId: version } : {}) } : {}),
      ...(action === 'reassign' ? { executor } : {}),
      ...(action === 'supplement' && !task.acceptanceCriteria?.length && acceptance.length ? { acceptanceCriteria: acceptance } : {}),
      ...(action === 'pass_test' ? { checkedCriteria: checked } : {}) }
    inFlight.current = true
    setSubmitting(true)
    const acknowledge = draft.acknowledge()
    try { const result = await run(WORKFLOW_ACTION_LABELS[action], async () => { if (!owns()) return { ok: false as const, error: '原任务来源已不可操作，请重新打开。' }; const result = await api.hifox.transitionTask(input); if (result.ok) acknowledge(); return result }); if (!owns()) return; if (result?.ok) onClose(); else setError(result && !result.ok ? result.error : '操作尚未完成，请核对结果后重试') }
    catch (cause) { if (owns()) setError(cause instanceof Error ? cause.message : '交接失败') }
    finally { inFlight.current = false; if (mounted.current) setSubmitting(false) }
  }
  return <Modal open onClose={onClose} width={560} ariaLabel={WORKFLOW_ACTION_LABELS[action]} placement="center"><div className="collab-flow-dialog-header"><h2>{action === 'arrange' && task.triagePending ? '接纳并安排' : WORKFLOW_ACTION_LABELS[action]}</h2><Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭交接"><X size={16} /></Button></div>
    <div className="collab-flow-dialog-body my-scrollbar"><fieldset disabled={busy || submitting || stageChanged} className="flex min-w-0 flex-col gap-4">
      {assigning && <Field label="分配给"><select className={inputClass} value={target} onChange={(event) => selectTarget(event.target.value)}><optgroup label="同事">{members.map((person) => <option key={person.id} value={`member:${person.id}`}>{person.name}{person.title ? ` · ${person.title}` : ''}</option>)}</optgroup><optgroup label="小队">{crews.map((crew) => <option key={crew.id} value={`crew:${crew.id}`}>{crew.name}</option>)}</optgroup><optgroup label="Agent">{agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup></select></Field>}
      {action === 'arrange' && <>
        <div className="grid grid-cols-2 gap-3"><Field label="工作内容"><select className={inputClass} value={workKind} onChange={(event) => setWorkKind(event.target.value === 'general' ? 'general' : 'code')}><option value="code">研发工作</option><option value="general">日常工作</option></select></Field>{workKind === 'code' && <Field label="下一步"><select className={inputClass} value={nextStage} onChange={(event) => setNextStage(event.target.value === 'dev_ready' ? 'dev_ready' : 'design_ready')}><option value="design_ready">先做设计</option><option value="dev_ready">直接开发</option></select></Field>}</div>
        {!task.iterationIds.length && <Field label="版本（选填）"><select className={inputClass} value={version} onChange={(event) => setVersion(event.target.value)}><option value="">未排期</option>{snapshot.iterations.filter((item) => item.spaceId === task.spaceId && item.status !== 'completed').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>}
        <Field label="验收标准"><textarea className={textareaClass} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一项" /></Field></>}
      {action === 'pass_test' && <div className="flex flex-col gap-3">{(task.acceptanceCriteria ?? []).map((criterion) => <label key={criterion} className="flex items-start gap-2 text-my-sm"><input type="checkbox" className="mt-0.5" checked={checked.includes(criterion)} onChange={(event) => setChecked((previous) => event.target.checked ? [...previous, criterion] : previous.filter((item) => item !== criterion))} /><span>{criterion}</span></label>)}</div>}
      {BODY_LABELS[action] && <Field label={BODY_LABELS[action] ?? '交接说明'}><textarea autoFocus className={textareaClass} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save() } }} /></Field>}
      {action === 'supplement' && !task.acceptanceCriteria?.length && <Field label="验收标准"><textarea className={textareaClass} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一项" /></Field>}
      {HANDED.has(action) && (!assigning || !target.startsWith('member:')) && <Field label="下一位处理人"><select className={inputClass} value={recipient} onChange={(event) => setRecipient(event.target.value)}>{members.map((person) => <option key={person.id} value={person.id}>{person.name}{person.title ? ` · ${person.title}` : ''}</option>)}</select></Field>}
    </fieldset>{draft.stale && <div role="alert" className="collab-inline-error"><span>任务内容已更新，草稿已保留。</span><details className="w-full"><summary>查看当前任务</summary><p className="whitespace-pre-wrap break-words">{task.title}{task.description ? `\n${task.description}` : ''}</p><ul className="list-disc pl-4">{task.acceptanceCriteria?.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></details><Button size="sm" disabled={busy || submitting || stageChanged} onClick={() => { if (owns()) draft.review() }}>已核对，继续编辑</Button></div>}{stageChanged && <div role="alert" className="collab-inline-error">任务阶段已更新，请关闭后核对当前进度。</div>}{error && <div role="alert" className="collab-inline-error">{error}</div>}</div>
    <footer className="collab-flow-dialog-footer">{draft.hasDraft && <Button variant="ghost" className="mr-auto" disabled={busy || submitting} onClick={() => { if (owns()) { draft.discard(); onClose() } }}>放弃草稿</Button>}<Button variant="outline" onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || submitting || stageChanged || draft.stale} onClick={() => void save()}>{submitting && <Loader2 size={14} className="animate-spin" />}{action === 'arrange' ? '确认安排' : action === 'reassign' ? '确认转交' : WORKFLOW_ACTION_LABELS[action]}</Button></footer>
  </Modal>
}
