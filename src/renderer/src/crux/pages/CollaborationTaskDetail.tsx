import { useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { Check, Code2, MessageSquare, MoreHorizontal, Star, Trash2, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { currentPostInput, fixedPostInput } from '@shared/crux'
import type { ConversationTaskDesign } from '@shared/conversation-task'
import { getCruxLightweightTaskCapabilities } from '@shared/crux-domain/lightweight'
import { canStartAssignedTaskPlan, getCruxTaskStageMetadata } from '@shared/crux-domain/workflow'
import { taskInputCanonical } from '@shared/team-canonical'
import type { TaskInputRead } from '@shared/team-task-inputs'
import { api, hasIpc } from '../../api'
import { conversationClient } from '../../conversations/client'
import { useConversations } from '../../conversations/workspace'
import { confirmDialog } from '../../components/Dialogs'
import { PageContent, PageLayout } from '../../my/layout/PageLayout'
import { Button, Dropdown, DropdownItem, Tooltip } from '../../my/ui'
import { InteractionScope } from '../../utils/interaction-scope'
import { memberOf, useCrux } from '../store'
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
import { ensureTaskConversationFromPost, openTaskConversationFromPost, type TaskConversationIntent } from '../../conversations/task-navigation'

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

const postTabs = { activity: '动态', conversations: '对话记录', workflow: '工作记录' } as const
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
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id, embedded })
  const { mutate, error, pending } = useTaskMutation(source)
  const [panel, setPanel] = useState<'properties' | 'research' | null>(null)
  const propertiesOpen = panel === 'properties'
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
  const [hasDesign, setHasDesign] = useState(false)
  const localChats = useConversations(state => state.conversations)
  const inputsRef = useRef<HTMLDetailsElement>(null)
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
  const links = task.conversations?.filter(link => link.actorId === actorId) ?? []
  const flow = getCruxLightweightTaskCapabilities(snapshot, task, actorId)
  const simple = flow.lightweight || flow.canRestore
  const desktop = Boolean(conversationClient())
  const availableTabs: PostTab[] = ['activity']
  if (desktop && links.length) availableTabs.push('conversations')
  if (!simple) availableTabs.push('workflow')
  const section = availableTabs.includes(selectedSection) ? selectedSection : 'activity'
  const status = snapshot.taskStatuses.find(item => item.id === task.statusId)
  const closed = status?.category === 'done' || status?.category === 'cancelled'
  const assignedTeamAgent = context.state === 'connected' && task.executor?.kind === 'agent'
  const existingCode = localChats.find(chat => chat.kind === 'code' && chat.nativeRef && chat.archivedAt === undefined && links.some(link => link.id === chat.id))
  const codeLabel = existingCode ? '继续工程对话' : '让 Agent 在工程中开发'
  const mayDevelop = desktop && !assignedTeamAgent && simple && !closed && !task.triagePending && Boolean(actorId) && !disabled
  const canPlanInProject = context.state === 'connected' && !closed && canStartAssignedTaskPlan(task, actorId)
  const project = task.projectId ? snapshot.projects.find(item => item.id === task.projectId && item.spaceId === task.spaceId) : undefined
  const workLabel = task.workflow?.stage === 'testing' ? '查看测试交付' : task.workflow?.stage === 'acceptance' ? '查看验收' : '查看当前工作'
  const done = flow.statusOptions.find(item => item.category === 'done')
  const switchSection = (next: PostTab, focus = false): void => {
    setSection(next)
    if (focus) requestAnimationFrame(() => tabBar.current?.querySelector<HTMLButtonElement>(`[data-post-tab="${next}"]`)?.focus())
  }
  const showComment = (id: string): void => {
    setSection('activity')
    requestAnimationFrame(() => tabBar.current?.parentElement?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus())
  }
  const close = (): void => { if (!embedded && source.owns()) useCrux.getState().openTask(null); if (embedded) onClose() }
  const askTaskAgent = async (conversationId?: string, kind: 'work' | 'code' = 'work', design?: ConversationTaskDesign, request?: TaskConversationIntent['request']): Promise<void> => {
    if (openingConversation.current || !actorId || (request && disabled)) return
    if (!conversationId && onContinue && kind === 'work' && !request) { onContinue(); return }
    const existingLink = conversationId ? links.find(link => link.id === conversationId) : links[0]
    if (!existingLink && (conversationId || disabled)) return
    const ticket = source.ticket()
    openingConversation.current = true
    setConversationPending(true); setConversationError('')
    const current = () => source.owns(ticket)
    try {
      if (kind === 'code' || !existingLink) await ensureTaskConversationFromPost(task, kind, current, design, request)
      else await openTaskConversationFromPost(task, existingLink.id, current, { request })
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
          <Tooltip label={following ? '取消关注' : '关注任务'}><Button size="sm" variant="ghost" disabled={disabled || !actorId} aria-label={following ? '取消关注任务' : '关注任务'} aria-pressed={following} onClick={() => { if (actorId) void mutate('更新任务关注', () => api.crux.updateTask({ id: task.id, patch: { followerToggle: actorId } })) }}><Star size={15} className={following ? 'fill-current' : ''} /></Button></Tooltip>
          <Dropdown align="right" width={170} trigger={({ toggle, open }) => <Tooltip label="更多任务操作"><Button size="sm" variant="ghost" aria-label="更多任务操作" aria-expanded={open} aria-haspopup="true" onClick={toggle}><MoreHorizontal size={16} /></Button></Tooltip>}>
            {(dismiss) => <>
              {hasDesign && mayDevelop && <DropdownItem icon={<Code2 size={14} />} disabled={conversationPending} onClick={() => { dismiss(); void askTaskAgent(undefined, 'code', undefined, 'develop') }}>{codeLabel}</DropdownItem>}
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
              </div>
              <TaskPostBody task={task} draft={draft} disabled={disabled || !actorId} mutate={mutate} onQuote={embedded ? onQuote : undefined} onPolish={embedded ? onPolish : undefined} editorDecoration={editorDecoration} />
              {embedded && reviewSlot}
              <TaskConversationResults task={task} actorId={actorId} embedded={embedded}
                onDesignAvailable={setHasDesign}
                onDevelop={mayDevelop && !conversationPending ? design => void askTaskAgent(undefined, 'code', design, 'develop') : undefined}
              />
              <div className="flex flex-wrap items-center gap-2">
                {desktop && (!closed || links.length > 0) && <Button size="sm" variant="outline" disabled={conversationPending || !actorId || (!links.length && disabled)} onClick={() => void askTaskAgent(undefined, 'work', undefined, links.length || closed || assignedTeamAgent ? undefined : 'analyze')}><MessageSquare size={14} />{conversationPending ? '正在打开…' : links.length ? '继续对话' : assignedTeamAgent ? '任务对话' : '让 Agent 分析'}</Button>}
                {!hasDesign && mayDevelop && (!existingCode || existingCode.id !== links[0]?.id) && <Button size="sm" variant="ghost" disabled={conversationPending} onClick={() => void askTaskAgent(undefined, 'code', undefined, 'develop')}><Code2 size={14} />{codeLabel}</Button>}
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
              {Boolean(task.descriptionHistory?.length) && <details><summary>描述历史</summary>{task.descriptionHistory?.map((revision, index) => <section key={index} className="mt-2"><h3 className="my-item-title">{revision.title}</h3><p className="whitespace-pre-wrap break-words">{revision.description}</p><time className="my-item-description">{formatCollaborationTime(revision.at)}</time></section>)}</details>}
              {Boolean(task.lightweightRestore?.workflow.history.length) && <details><summary>此前的交接记录</summary>
                {task.lightweightRestore?.workflow.history.map(event => <div key={event.id} className="mt-2">
                  <p className="my-item-title">{getCruxTaskStageMetadata(event.toStage).label} · {memberOf(snapshot, event.actorId)?.name ?? event.actorId}</p>
                  <time className="my-item-description">{formatCollaborationTime(event.at)}</time>
                  {event.body && <p className="whitespace-pre-wrap break-words text-my-sm">{event.body}</p>}
                </div>)}
              </details>}
              {task.handoff?.files?.length ? <TaskPostFiles scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={task.handoff.id} files={task.handoff.files} current={source.owns} /> : null}
              {(task.handoff || Boolean(task.sharedMaterials?.length)) && <TaskHandoffProvenance key={JSON.stringify([taskSourceKey(snapshot, context), task.id, task.createdAt, task.handoff, task.sharedMaterials])} task={task} source={source} onOpenConversation={embedded ? conversationId => void openTaskConversationFromPost(task, conversationId) : undefined} />}
              {!simple && basis && <details><summary>{changedBasis ? '本轮规划依据（与当前任务有差异）' : '本轮规划依据'}</summary>
                {task.workflow?.history.filter(event => event.postInput).slice().reverse().map(event => event.postInput && <section key={event.id} className="mt-3">
                  <h3 className="my-item-title">{event.postInput.title} · {formatCollaborationTime(event.at)}</h3>
                  <p className="whitespace-pre-wrap break-words">{event.postInput.description}</p>
                  <ul>{event.postInput.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
                  {event.postInput.sources.map(group => <TaskPostFiles key={group.id} scope={{ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }} sourceId={group.id} files={group.files} current={source.owns} />)}
                </section>)}
                {changedBasis && task.workflow?.stage === 'planning' && actorId === (task.workflow.handlerId ?? task.assigneeIds[0]) && <Button disabled={disabled} onClick={() => void mutate('按当前内容重新规划', () => api.crux.transitionTask({
                  taskId: task.id, action: 'begin_development', expectedStage: 'planning', expectedUpdatedAt: task.updatedAt,
                  ...(task.workflow?.deliveryState ? { expectedDeliveryRevision: task.workflow.deliveryState.revision } : {})
                }))}>按当前内容重新规划</Button>}
              </details>}
              <section className="task-post-updates">
                <div ref={tabBar} className="task-post-tabs" role="tablist" aria-label="任务记录">
                  {availableTabs.map((tab, index) => <button key={tab} type="button" role="tab" data-post-tab={tab}
                    id={`${sectionId}-${tab}`} aria-controls={`${sectionId}-panel`} aria-selected={section === tab} tabIndex={section === tab ? 0 : -1}
                    onClick={() => switchSection(tab)} onKeyDown={event => {
                      const next = event.key === 'ArrowRight' ? (index + 1) % availableTabs.length : event.key === 'ArrowLeft' ? (index + availableTabs.length - 1) % availableTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? availableTabs.length - 1 : -1
                      if (next >= 0) { event.preventDefault(); switchSection(availableTabs[next], true) }
                    }}>{postTabs[tab]}</button>)}
                </div>
                <div id={`${sectionId}-panel`} role="tabpanel" aria-labelledby={`${sectionId}-${section}`} className="task-post-tab-content">
                  {section === 'activity' && <TaskDiscussion taskDraft={draft} snapshot={snapshot} task={task} actorId={actorId} disabled={disabled} mutate={mutate} source={source} />}
                  {section === 'conversations' && <div className="task-post-conversations">
                    {links.map(link => {
                      const chat = localChats.find(item => item.id === link.id)
                      return <button key={link.id} className="task-post-conversation" disabled={conversationPending} onClick={() => void askTaskAgent(link.id)}>
                        <MessageSquare size={16} aria-hidden="true" />
                        <span><strong className="my-item-title">{chat?.title ?? link.title}</strong>
                          {chat?.conversationPreview && <span className="my-item-description">{chat.conversationPreview}</span>}
                        </span>
                      </button>
                    })}
                    {!links.length && <Button variant="ghost" size="sm" disabled={!actorId || disabled || conversationPending} onClick={() => void askTaskAgent()}>问 Agent</Button>}
                  </div>}
                  {section === 'workflow' && <div className="flex flex-col gap-4">
              <TaskWorkflow snapshot={snapshot} task={task} source={source} resourceRefresh={resourceRefresh} workflowInputs={context.state === 'local' ? undefined : workflowInputs} onMaterialCommitted={() => { if (source.owns()) { setMaterialRefresh((value) => value + 1); setResourceRefresh((value) => value + 1) } }} onOpenInputs={sharedInputs ? () => {
                if (source.owns() && inputsRef.current) {
                  inputsRef.current.open = true
                  inputsRef.current.querySelector('summary')?.focus()
                }
              } : undefined} />
              <details className="space-y-3"><summary>代码资源与进度</summary>
                <TaskCodeResources task={task} onSelected={() => setResourceRefresh((value) => value + 1)} /><TaskProgressPanel snapshot={snapshot} task={task} />
              </details>
              {sharedInputs && <details ref={inputsRef} className="space-y-3"><summary>采用的材料与规则</summary><TaskInputPanel key={`${taskSourceKey(snapshot, context)}:${space.id}:${task.id}:${task.createdAt}`} api={governanceApi} workspaceKey={context.key} spaceId={space.id} taskId={task.id} taskCreatedAt={task.createdAt} actorId={actorId} materialsApi={materialsApi} refreshRevision={materialRefresh} workspaceRevision={context.revision} canAdopt={canAdoptInputs} onRead={setWorkflowInputs} onAdopted={() => { if (source.owns()) setResourceRefresh((value) => value + 1) }} /></details>}
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
