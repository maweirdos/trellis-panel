import { useId, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { ArrowRight, Bell, Bot, Check, ChevronRight, Code2, MessageSquare, MoreHorizontal, Star, Trash2, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { currentPostInput, fixedPostInput } from '@shared/crux'
import { getCruxLightweightTaskCapabilities } from '@shared/crux-domain/lightweight'
import { isOrdinaryConversationTask } from '@shared/conversation/task-scope'
import { canStartAssignedTaskPlan, getCruxTaskStageMetadata } from '@shared/crux-domain/workflow'
import { taskInputCanonical } from '@shared/team-canonical'
import type { TaskInputRead } from '@shared/team-task-inputs'
import { api, hasIpc } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { PageContent, PageLayout } from '../../my/layout/PageLayout'
import { StateGroupIcon } from '../../my/icons'
import { Button, DisclosureGrid, Dropdown, DropdownItem, Tabs, Tooltip } from '../../my/ui'
import { InteractionScope } from '../../utils/interaction-scope'
import { resolveAllowedTargetStatusIds, useCollaborationPlatform } from '../collaboration-platform-store'
import { memberOf, statusDisplayName, useCrux } from '../store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from '../task-workspace-adapter'

function DetailDisclosure({
  title,
  open: controlledOpen,
  onToggle,
  buttonRef,
  children,
  className = ''
}: {
  title: string
  open?: boolean
  onToggle?: (next: boolean) => void
  buttonRef?: RefObject<HTMLButtonElement>
  children: ReactNode
  className?: string
}): JSX.Element {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const toggle = (): void => {
    if (onToggle) onToggle(!open)
    else setLocalOpen((prev) => !prev)
  }
  return (
    <section className={`rounded-my-base border border-my-line bg-my-canvas/60 px-3 py-2 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="my-disclosure-trigger flex w-full items-center gap-1.5 py-0.5 text-left text-my-xs font-medium text-my-secondary transition-colors hover:text-my-primary"
      >
        <ChevronRight size={13} className="my-disclosure-chevron shrink-0 text-my-icon-tertiary" data-open={open} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <DisclosureGrid open={open}>
        <div className="space-y-3 pt-2.5">{children}</div>
      </DisclosureGrid>
    </section>
  )
}
import { isActiveRunStatus, RUN_STATUS_META, useTaskRuns } from '../task-run-store'
import { TaskExecutionRunPanel } from '../TaskExecutionRunPanel'
import { TaskWorkflow } from '../TaskWorkflow'
import { TaskConversationResults } from './task-detail/TaskConversationResults'
import { formatCollaborationTime } from '../ui'
import { NewTaskModal } from './TaskCreateModal'
import { TaskPostControls, updatePostAssignmentOrStatus } from './task-detail/TaskPostControls'
import { TaskPostFiles } from './task-detail/TaskPostFiles'
import { TaskResearch } from './task-detail/TaskResearch'
import { TaskPostBody, TaskPostTitle, type TaskPostSelection } from './task-detail/TaskPostEditor'
import { TaskDiscussion } from './task-detail/TaskDiscussion'
import { TaskLinks } from './task-detail/TaskLinks'
import { TaskProperties } from './task-detail/TaskProperties'
import { canReadTaskSpace, taskActorId, taskSourceKey, useTaskMutation, useTaskSource, useTaskSurfaceGeneration } from './task-detail/use-task-source'
import { useTaskDraft } from './task-detail/task-drafts'
import { TaskProgressPanel } from './task-detail/TaskProgressPanel'
import { TaskCodeResources } from '../code-resources/TaskCodeResources'
import { TaskInputPanel } from '../governance/TaskInputPanel'
import { TaskHandoffProvenance } from './task-detail/TaskHandoffProvenance'
import { openOrdinaryTaskConversation } from '../task-conversation'
import { openTaskWorkThread } from '../../conversation-workbench/task-work-navigation'

export function TaskDetailDrawer(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const taskId = useCrux((state) => state.openTaskId)
  const context = useCrux((state) => state.workspaceContext)
  const generation = useTaskSurfaceGeneration()
  const task = snapshot?.tasks.find((candidate) => candidate.id === taskId)
  if (!snapshot || !task || !canReadTaskSpace(snapshot, context, task.spaceId)) return null
  return <section className="team-task-reader" aria-label="任务工作区">
    <InteractionScope key={`${taskSourceKey(snapshot, context)}:${task.id}:${task.createdAt}:${generation}`} active>
    <TaskDetails snapshot={snapshot} task={task} onClose={() => useCrux.getState().openTask(null)} />
    </InteractionScope>
  </section>
}

export interface EmbeddedTaskPostProps {
  taskId: string
  onClose(): void
  onContinue?(): void
  onQuote?(selection: TaskPostSelection): boolean | void
  onPolish?(selection: TaskPostSelection): boolean | void
  reviewSlot?: ReactNode
  editorDecoration?: ReactNode
}

export function EmbeddedTaskPost({ taskId, onClose, onContinue, onQuote, onPolish, reviewSlot, editorDecoration }: EmbeddedTaskPostProps): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const context = useCrux((state) => state.workspaceContext)
  const generation = useTaskSurfaceGeneration()
  const task = snapshot?.tasks.find((candidate) => candidate.id === taskId)
  if (!snapshot || !task || !canReadTaskSpace(snapshot, context, task.spaceId)) return null
  return <InteractionScope key={`embedded:${taskSourceKey(snapshot, context)}:${task.id}:${task.createdAt}:${generation}`} active>
    <TaskDetails snapshot={snapshot} task={task} embedded onClose={onClose} onContinue={onContinue} onQuote={onQuote} onPolish={onPolish} reviewSlot={reviewSlot} editorDecoration={editorDecoration} />
  </InteractionScope>
}

const postTabs = { activity: '动态', runs: '执行与 AI', conversations: '对话记录', workflow: '工作记录' } as const
type PostTab = keyof typeof postTabs

function TaskDetails({ snapshot, task, embedded = false, onClose, onContinue, onQuote, onPolish, reviewSlot, editorDecoration }: {
  snapshot: CruxSnapshot
  task: CruxTask
  embedded?: boolean
  onClose(): void
  onContinue?(): void
  onQuote?(selection: TaskPostSelection): boolean | void
  onPolish?(selection: TaskPostSelection): boolean | void
  reviewSlot?: ReactNode
  editorDecoration?: ReactNode
}): JSX.Element | null {
  const context = useCrux((state) => state.workspaceContext)
  const busy = useCrux((state) => state.busy)
  const typeWorkflows = useCollaborationPlatform((state) => state.typeWorkflows)
  const favorites = useCollaborationPlatform((state) => state.favorites)
  const toggleFavorite = useCollaborationPlatform((state) => state.toggleFavorite)
  const taskRuns = useTaskRuns((state) => state.runs).filter((run) => run.taskId === task.id)
  const activeRun = taskRuns.find((run) => isActiveRunStatus(run.status))
  const queuedRunCount = taskRuns.filter((run) => run.status === 'queued').length
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id, embedded })
  const { mutate, error, pending } = useTaskMutation(source)
  const [panel, setPanel] = useState<'properties' | 'research' | null>(() => (embedded ? null : 'properties'))
  const propertiesOpen = panel === 'properties'
  const starred = favorites.some((fav) => fav.kind === 'task' && fav.id === task.id)
  const subtasks = snapshot.tasks.filter((candidate) => candidate.parentTaskId === task.id)
  const doneSubtasks = subtasks.filter((candidate) => snapshot.taskStatuses.find((st) => st.id === candidate.statusId)?.category === 'done').length
  const [selectedSection, setSection] = useState<PostTab>('activity')
  const sectionId = useId()
  const tabBar = useRef<HTMLDivElement>(null)
  const [resourceRefresh, setResourceRefresh] = useState(0)
  const [materialRefresh, setMaterialRefresh] = useState(0)
  const [workflowInputs, setWorkflowInputs] = useState<TaskInputRead | null>(null)
  const draft = useTaskDraft(snapshot, context, { kind: 'details', spaceId: task.spaceId, task })
  const [subtaskOpen, setSubtaskOpen] = useState(false)
  const [conversationPending, setConversationPending] = useState(false)
  const openingConversation = useRef(false)
  const [conversationError, setConversationError] = useState('')
  const [starPopKey, setStarPopKey] = useState(0)
  const [inputsOpen, setInputsOpen] = useState(false)
  const inputsToggleRef = useRef<HTMLButtonElement>(null)
  const space = snapshot.spaces.find((candidate) => candidate.id === task.spaceId)
  if (!source.available || !space) return null
  const identity = taskActorId(snapshot, context)
  const actorId = identity && space.memberIds.includes(identity) ? identity : undefined
  const disabled = busy || pending || !hasIpc || Boolean(space.archived)
  const governanceApi = api && Object.hasOwn(api, 'cruxGovernance') ? api.cruxGovernance : undefined
  const materialsApi = api && Object.hasOwn(api, 'cruxMaterials') ? api.cruxMaterials : undefined
  const sharedInputs = governanceApi && context.state !== 'local' && canReadTaskSpace(snapshot, context, space.id)
  // The mounted source lease is checked by callbacks, after the initial render.
  const canAdoptInputs = !disabled && context.state === 'connected' && source.available && Boolean(actorId &&
    (context.canManage || space.ownerId === actorId || task.creatorId === actorId || (task.workflow ? task.workflow.handlerId === actorId : task.assigneeIds.includes(actorId))))
  const following = Boolean(actorId && task.followerIds.includes(actorId))
  const confirmed = task.clarifications?.filter(note => !note.withdrawn) ?? []
  const basis = fixedPostInput(task)
  const changedBasis = basis && taskInputCanonical(basis) !== taskInputCanonical(currentPostInput(task, snapshot.comments))
  const workSources = task.conversations?.filter(link => link.actorId === actorId && link.id.startsWith('thr_')) ?? []
  const flow = getCruxLightweightTaskCapabilities(snapshot, task, actorId)
  const simple = flow.lightweight || flow.canRestore
  const desktop = hasIpc && typeof api.conversationRead === 'function'
  const availableTabs: PostTab[] = ['activity', 'runs']
  if (desktop && workSources.length) availableTabs.push('conversations')
  if (!simple) availableTabs.push('workflow')
  const section = availableTabs.includes(selectedSection) ? selectedSection : 'activity'
  const status = snapshot.taskStatuses.find(item => item.id === task.statusId)
  const closed = status?.category === 'done' || status?.category === 'cancelled'
  const allowedTargets = resolveAllowedTargetStatusIds(snapshot, task, typeWorkflows)
  const nextFlowStatuses = snapshot.taskStatuses
    .filter((item) => item.spaceId === task.spaceId && item.id !== task.statusId && allowedTargets.has(item.id))
    .sort((a, b) => a.order - b.order)
    .slice(0, 4)
  const ordinaryTaskChat = context.state === 'connected' && isOrdinaryConversationTask(task)
  const mayOpenOrdinaryChat = ordinaryTaskChat && Boolean(actorId && task.assigneeIds[0] === actorId && !task.triagePending && !disabled)
  const canPlanInProject = context.state === 'connected' && !closed && canStartAssignedTaskPlan(task, actorId)
  const project = task.projectId ? snapshot.projects.find(item => item.id === task.projectId && item.spaceId === task.spaceId) : undefined
  const workLabel = task.workflow?.stage === 'testing' ? '查看测试交付' : task.workflow?.stage === 'acceptance' ? '查看验收' : '查看当前工作'
  const done = flow.statusOptions.find(item => item.category === 'done')
  const switchSection = (next: PostTab, focus = false): void => {
    setSection(next)
    if (focus) requestAnimationFrame(() => tabBar.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus())
  }
  const showComment = (id: string): void => {
    setSection('activity')
    requestAnimationFrame(() => tabBar.current?.parentElement?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus())
  }
  const close = (): void => { if (!embedded && source.owns()) useCrux.getState().openTask(null); if (embedded) onClose() }
  const askTaskAgent = async (conversationId?: string): Promise<void> => {
    if (openingConversation.current || !actorId) return
    const workSource = conversationId && workSources.find(link => link.id === conversationId)
    if (!conversationId && !ordinaryTaskChat && onContinue) { onContinue(); return }
    if (!workSource && (conversationId || !mayOpenOrdinaryChat)) return
    const ticket = source.ticket()
    openingConversation.current = true
    setConversationPending(true); setConversationError('')
    const current = () => source.owns(ticket)
    try {
      if (workSource) await openTaskWorkThread(task, workSource.id, current)
      else await openOrdinaryTaskConversation(context.key, task, current)
    }
    catch (cause) { if (source.owns(ticket)) setConversationError(cause instanceof Error ? cause.message : String(cause)) }
    finally { openingConversation.current = false; if (source.owns(ticket)) setConversationPending(false) }
  }
  const removeTask = async (): Promise<void> => {
    const ticket = source.ticket()
    if (disabled || !source.canWrite(ticket)) return
    const confirmed = await confirmDialog({ title: `删除任务「${task.title}」？`, message: '任务及其评论会被删除，已有子任务将保留。', confirmText: '删除任务', danger: true }, source.signal)
    if (confirmed && source.canWrite(ticket)) await mutate('删除任务', () => api.crux.removeTask({ id: task.id }))
  }
  const content = <>
    <div className="collab-task-detail flex min-h-0 flex-1 flex-col bg-my-canvas">
      <PageLayout variant="full" className="collab-task-detail-layout" style={{ height: 'auto', background: 'inherit' }}>
        <header className="collab-task-detail-header flex shrink-0 flex-wrap items-center gap-2 border-b border-my-line px-4">
        <span className="min-w-0 truncate text-my-xs text-my-tertiary">{space.name}</span><span className="shrink-0 text-my-sm text-my-secondary">{task.id}</span>
        <span className="collab-task-source-chip">{context.state === 'local' ? '本机任务' : '团队任务'}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip label={starred ? '从侧边栏取消收藏' : '收藏到侧边栏'}><Button size="sm" variant="ghost" aria-label={starred ? '取消收藏任务' : '收藏任务'} aria-pressed={starred} onClick={() => { setStarPopKey((v) => v + 1); toggleFavorite('task', task.id, task.spaceId) }}><Star key={starPopKey} size={15} className={starred ? 'my-star-pop fill-current text-my-warning-text' : ''} /></Button></Tooltip>
          <Tooltip label={following ? '取消关注动态' : '关注任务动态'}><Button size="sm" variant="ghost" disabled={disabled || !actorId} aria-label={following ? '取消关注任务' : '关注任务'} aria-pressed={following} onClick={() => { if (actorId) void mutate('更新任务关注', () => api.crux.updateTask({ id: task.id, patch: { followerToggle: actorId } })) }}><Bell size={15} className={following ? 'fill-current' : ''} /></Button></Tooltip>
          <Dropdown align="right" width={170} trigger={({ toggle, open }) => <Tooltip label="更多任务操作"><Button size="sm" variant="ghost" aria-label="更多任务操作" aria-expanded={open} aria-haspopup="true" onClick={toggle}><MoreHorizontal size={16} /></Button></Tooltip>}>
            {(dismiss) => <>
              {context.state === 'connected' && api.teamContent && <DropdownItem onClick={() => { dismiss(); setPanel('research') }}>Agent 调研</DropdownItem>}
              <DropdownItem danger disabled={disabled} icon={<Trash2 size={14} />} onClick={() => { dismiss(); void removeTask() }}>删除任务</DropdownItem>
            </>}
          </Dropdown>
          <Tooltip label="关闭详情"><Button size="sm" variant="ghost" aria-label="关闭详情" onClick={close}><X size={16} /></Button></Tooltip>
        </div>
        </header>
        <PageContent variant="full" className="collab-task-detail-frame" style={{ padding: 0 }}>
          <div className="collab-task-detail-body my-scrollbar" data-properties={Boolean(panel) || undefined}>
          <div className="collab-task-detail-content">
        {space.archived && <p role="status" className="border-b border-my-line px-4 py-2 text-my-xs text-my-tertiary">空间已停用 · 只读</p>}
        {conversationError && <p role="alert" className="collab-inline-error mx-4 mt-3">{conversationError}</p>}
        {error && <p role="alert" className="collab-inline-error mx-4 mt-3">{error}</p>}
        <div className="collab-task-detail-scroll my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <article className="collab-task-story flex min-w-0 flex-col gap-4" aria-label="任务详情">
              <TaskPostTitle task={task} draft={draft} disabled={disabled || !actorId} mutate={mutate} />
              <div className="flex flex-wrap items-center gap-2"><TaskPostControls task={task} snapshot={snapshot} actor={actorId} disabled={disabled} mutate={mutate} onProperties={() => setPanel(propertiesOpen ? null : 'properties')} onWorkflow={() => switchSection('workflow', true)} />
                {project && <span className="my-item-description">专项 · {project.name}</span>}
                {(activeRun || queuedRunCount > 0) && (
                  <button
                    type="button"
                    onClick={() => switchSection('runs', true)}
                    className={`inline-flex items-center gap-1.5 rounded-my-base border border-my-line px-2 py-1 text-my-xs font-medium ${activeRun ? 'bg-my-info-subtle text-my-info-text' : 'bg-my-layer-1 text-my-secondary'}`}
                  >
                    <Bot size={13} />
                    {activeRun ? `${activeRun.executorName} · ${RUN_STATUS_META[activeRun.status].label}` : `${queuedRunCount} 个执行排队中`}
                  </button>
                )}
              </div>
              {!task.workflow && nextFlowStatuses.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-my-base border border-my-line bg-my-layer-1 px-3 py-2" aria-label="工作流快捷流转">
                  <span className="text-my-xs text-my-tertiary">流转至：</span>
                  {nextFlowStatuses.map((target) => (
                    <Button
                      key={target.id}
                      size="sm"
                      variant={target.category === 'done' ? 'soft' : 'outline'}
                      disabled={disabled}
                      onClick={() => void mutate(`流转至 ${statusDisplayName(target)}`, () => api.crux.updateTask({ id: task.id, patch: { statusId: target.id } }))}
                    >
                      <StateGroupIcon stateGroup={CRUX_STATE_GROUPS[target.category]} size={13} color={cruxStatusColor(target.category)} />
                      {statusDisplayName(target)}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => switchSection('runs', true)}>
                    <Bot size={13} />AI 执行 ({taskRuns.length})
                  </Button>
                </div>
              )}
              <TaskPostBody task={task} draft={draft} disabled={disabled || !actorId} mutate={mutate} onQuote={embedded ? onQuote : undefined} onPolish={embedded ? onPolish : undefined} editorDecoration={editorDecoration} />
              {subtasks.length > 0 && (
                <section className="flex flex-col gap-1.5 rounded-my-base border border-my-line bg-my-layer-1 px-3 py-2.5" aria-label="子任务进度">
                  <div className="flex items-center justify-between text-my-xs">
                    <span className="font-medium text-my-primary">子任务进度</span>
                    <span className="tabular-nums text-my-tertiary">{doneSubtasks}/{subtasks.length}（{Math.round((doneSubtasks / subtasks.length) * 100)}%）</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-my-layer-2">
                    <div className="h-full rounded-full bg-my-accent" style={{ width: `${Math.round((doneSubtasks / subtasks.length) * 100)}%` }} />
                  </div>
                </section>
              )}
              {embedded && reviewSlot}
              <TaskConversationResults task={task} actorId={actorId} embedded={embedded} />
              <div className="flex flex-wrap items-center gap-2">
                {desktop && (ordinaryTaskChat || onContinue) && <Button size="sm" variant="outline"
                  disabled={conversationPending || (ordinaryTaskChat ? !mayOpenOrdinaryChat : !actorId || disabled)}
                  onClick={() => void askTaskAgent()}>
                  <MessageSquare size={14} aria-hidden="true" />{conversationPending ? '正在打开…' : '任务对话'}
                </Button>}
                {desktop && workSources.map(link => <Button key={link.id} size="sm" variant="ghost" disabled={conversationPending}
                  aria-label={`回看原 Work 对话 · ${link.title}`} onClick={() => void askTaskAgent(link.id)}>
                  <MessageSquare size={14} aria-hidden="true" />回看原 Work 对话
                </Button>)}
                {canPlanInProject && <Button size="sm" variant="outline" disabled={disabled} onClick={async () => {
                  const result = await mutate('打开工程规划', () => api.crux.transitionTask({
                    taskId: task.id, action: 'begin_development', expectedUpdatedAt: task.updatedAt
                  }))
                  if (result) switchSection('workflow', true)
                }}><Code2 size={14} />工程规划</Button>}
                {!simple && task.workflow && !closed && section !== 'workflow' && <Button size="sm" variant="ghost" onClick={() => switchSection('workflow', true)}>{workLabel}</Button>}
                {simple && !closed && done && (flow.canEditStatus || flow.canRestore) && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void mutate('标记完成', () => updatePostAssignmentOrStatus(task, { statusId: done.id }))}><Check size={14} />标记完成</Button>}
              </div>
              {Boolean(task.acceptanceCriteria?.length) && <section><h3 className="mb-2 text-my-sm font-medium text-my-primary">验收标准</h3><ol className="list-decimal space-y-2 pl-5 text-my-sm text-my-secondary">{task.acceptanceCriteria?.map((criterion, index) => <li key={index} className="whitespace-pre-wrap break-words">{criterion}</li>)}</ol></section>}
              {confirmed.length > 0 && <section><h3 className="my-item-title">已确认补充</h3>{confirmed.map(note => <div key={note.commentId} className="mt-2"><p className="whitespace-pre-wrap break-words">{note.body}</p><Button size="sm" variant="ghost" onClick={() => showComment(`task-comment-${note.commentId}`)}>{memberOf(snapshot, note.confirmedBy)?.name ?? note.confirmedBy} · {formatCollaborationTime(note.confirmedAt)} · 查看原评论</Button></div>)}</section>}
              {Boolean(task.descriptionHistory?.length) && (
                <DetailDisclosure title="描述历史">
                  {task.descriptionHistory?.map((revision, index) => (
                    <section key={index}>
                      <h3 className="my-item-title">{revision.title}</h3>
                      <p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{revision.description}</p>
                      <time className="my-item-description">{formatCollaborationTime(revision.at)}</time>
                    </section>
                  ))}
                </DetailDisclosure>
              )}
              {Boolean(task.lightweightRestore?.workflow.history.length) && (
                <DetailDisclosure title="此前的交接记录">
                  {task.lightweightRestore?.workflow.history.map((event) => (
                    <div key={event.id}>
                      <p className="my-item-title">{getCruxTaskStageMetadata(event.toStage).label} · {memberOf(snapshot, event.actorId)?.name ?? event.actorId}</p>
                      <time className="my-item-description">{formatCollaborationTime(event.at)}</time>
                      {event.body && <p className="whitespace-pre-wrap break-words text-my-sm">{event.body}</p>}
                    </div>
                  ))}
                </DetailDisclosure>
              )}
              {task.handoff?.files?.length ? <TaskPostFiles scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={task.handoff.id} files={task.handoff.files} current={source.owns} /> : null}
              {(task.handoff || Boolean(task.sharedMaterials?.length)) && <TaskHandoffProvenance key={JSON.stringify([taskSourceKey(snapshot, context), task.id, task.createdAt, task.handoff, task.sharedMaterials])} task={task} source={source} />}
              {!simple && basis && (
                <DetailDisclosure title={changedBasis ? '本轮规划依据（与当前任务有差异）' : '本轮规划依据'}>
                  {task.workflow?.history.filter((event) => event.postInput).slice().reverse().map((event) => event.postInput && (
                    <section key={event.id}>
                      <h3 className="my-item-title">{event.postInput.title} · {formatCollaborationTime(event.at)}</h3>
                      <p className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{event.postInput.description}</p>
                      <ul>{event.postInput.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
                      {event.postInput.sources.map((group) => <TaskPostFiles key={group.id} scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={group.id} files={group.files} current={source.owns} />)}
                    </section>
                  ))}
                  {changedBasis && task.workflow?.stage === 'planning' && actorId === (task.workflow.handlerId ?? task.assigneeIds[0]) && (
                    <Button disabled={disabled} onClick={() => void mutate('按当前内容重新规划', () => api.crux.transitionTask({
                      taskId: task.id, action: 'begin_development', expectedStage: 'planning', expectedUpdatedAt: task.updatedAt,
                      ...(task.workflow?.deliveryState ? { expectedDeliveryRevision: task.workflow.deliveryState.revision } : {})
                    }))}>按当前内容重新规划</Button>
                  )}
                </DetailDisclosure>
              )}
              <section className="task-post-updates">
                <div ref={tabBar} className="shrink-0">
                  <Tabs
                    tabs={availableTabs.map((t) => ({ id: t, label: postTabs[t] }))}
                    active={section}
                    onChange={(next) => switchSection(next)}
                    ariaLabel="任务记录"
                  />
                </div>
                <div key={section} id={`${sectionId}-panel`} role="tabpanel" aria-labelledby={`${sectionId}-${section}`} className="task-post-tab-content my-subview-stage">
                  {section === 'activity' && <TaskDiscussion taskDraft={draft} snapshot={snapshot} task={task} actorId={actorId} disabled={disabled} mutate={mutate} source={source} />}
                  {section === 'runs' && <TaskExecutionRunPanel snapshot={snapshot} task={task} actorId={actorId} disabled={disabled} mutate={mutate} />}
                  {section === 'conversations' && <div className="task-post-conversations">
                    {workSources.map(link =>
                      <button key={link.id} type="button" className="task-post-conversation" disabled={conversationPending} onClick={() => void askTaskAgent(link.id)}>
                        <MessageSquare size={16} aria-hidden="true" />
                        <span className="my-item-title">{link.title}</span>
                      </button>
                    )}
                  </div>}
                  {section === 'workflow' && <div className="flex flex-col gap-4">
              <TaskWorkflow snapshot={snapshot} task={task} source={source} resourceRefresh={resourceRefresh} workflowInputs={context.state === 'local' ? undefined : workflowInputs} onMaterialCommitted={() => { if (source.owns()) { setMaterialRefresh((value) => value + 1); setResourceRefresh((value) => value + 1) } }} onOpenInputs={sharedInputs ? () => {
                if (source.owns()) {
                  setInputsOpen(true)
                  requestAnimationFrame(() => inputsToggleRef.current?.focus())
                }
              } : undefined} />
              <DetailDisclosure title="代码资源与进度">
                <TaskCodeResources task={task} onSelected={() => setResourceRefresh((value) => value + 1)} /><TaskProgressPanel snapshot={snapshot} task={task} />
              </DetailDisclosure>
              {sharedInputs && (
                <DetailDisclosure
                  title="采用的材料与规则"
                  open={inputsOpen}
                  onToggle={setInputsOpen}
                  buttonRef={inputsToggleRef}
                >
                  <TaskInputPanel key={`${taskSourceKey(snapshot, context)}:${space.id}:${task.id}:${task.createdAt}`} api={governanceApi} workspaceKey={context.key} spaceId={space.id} taskId={task.id} taskCreatedAt={task.createdAt} actorId={actorId} materialsApi={materialsApi} refreshRevision={materialRefresh} workspaceRevision={context.revision} canAdopt={canAdoptInputs} onRead={setWorkflowInputs} onAdopted={() => { if (source.owns()) setResourceRefresh((value) => value + 1) }} />
                </DetailDisclosure>
              )}
                  </div>}
                </div>
              </section>
          </article>
        </div>
          </div>
          {panel === 'research' && <aside className="collab-task-detail-properties my-scrollbar" aria-label="Agent 调研"><div className="mb-3 flex items-center justify-between"><h3 className="my-item-title">Agent 调研</h3><Button size="sm" variant="ghost" aria-label="收起调研" onClick={() => setPanel(null)}><X size={14} /></Button></div><TaskResearch task={task} snapshot={snapshot} source={source} draft={draft} onQuote={() => { setPanel(null); showComment(`task-comment-input-${task.id}`) }} /></aside>}
          {propertiesOpen && <aside className="collab-task-detail-properties my-scrollbar" aria-label="任务属性区域">
            <div className="mb-3 flex items-center justify-between gap-2"><h3 className="my-item-title">任务属性</h3><Button size="sm" variant="ghost" aria-label="收起任务属性" onClick={() => setPanel(null)}><X size={14} /></Button></div>
            <TaskProperties snapshot={snapshot} task={task} disabled={disabled} actorId={actorId} source={source} mutate={mutate} onOpenTask={embedded ? targetTaskId => { onClose(); useCrux.getState().openTask(targetTaskId) } : undefined} />
            <div className="mt-4 border-t border-my-line pt-4"><TaskLinks snapshot={snapshot} task={task} disabled={disabled} source={source} mutate={mutate} onNewSubtask={() => setSubtaskOpen(true)} /></div>
          </aside>}
          </div>
        </PageContent>
      </PageLayout>
      <NewTaskModal open={subtaskOpen} onClose={() => setSubtaskOpen(false)} spaceId={task.spaceId} parentTaskId={task.id} projectId={task.projectId} iterationId={task.iterationIds[0]} />
    </div>
  </>
  return embedded
    ? <section className="embedded-task-post" aria-label={`${task.id} · ${task.title}`}>{content}</section>
    : <div className="embedded-task-post" aria-label={`${task.id} · ${task.title}`} role="region">{content}</div>
}
