import { useRef, useState, type JSX } from 'react'
import { Maximize2, Minimize2, MoreHorizontal, Pencil, Star, Trash2, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask, CruxTaskStage } from '@shared/crux'
import { getCruxTaskStageMetadata } from '@shared/crux-domain/workflow'
import { api, hasIpc } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { PageContent, PageLayout } from '../../my/layout/PageLayout'
import { Button, Dropdown, DropdownItem, Modal, Tabs, Tooltip } from '../../my/ui'
import { InteractionScope } from '../../utils/interaction-scope'
import { statusOf, useCrux } from '../store'
import { TaskWorkflow } from '../TaskWorkflow'
import { TaskCreationReferences } from '../../creations/TaskCreationReferences'
import { Field, formatCollaborationTime, inputClass, PriorityBadge, StatusBadge, textareaClass } from '../ui'
import { NewTaskModal } from './TaskCreateModal'
import { TaskDiscussion } from './task-detail/TaskDiscussion'
import { TaskLinks } from './task-detail/TaskLinks'
import { TaskProperties } from './task-detail/TaskProperties'
import { canReadTaskSpace, taskActorId, taskSourceKey, useTaskMutation, useTaskSource, useTaskSurfaceGeneration } from './task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './task-detail/task-drafts'
import { TaskProgressPanel } from './task-detail/TaskProgressPanel'
import { TaskCodeResources } from '../code-resources/TaskCodeResources'
import { TaskInputPanel } from '../governance/TaskInputPanel'

function getTaskStageLabel(stage: CruxTaskStage): string {
  return getCruxTaskStageMetadata(stage).label
}

export function TaskDetailDrawer(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const taskId = useCrux((state) => state.openTaskId)
  const context = useCrux((state) => state.workspaceContext)
  const generation = useTaskSurfaceGeneration()
  const task = snapshot?.tasks.find((candidate) => candidate.id === taskId)
  if (!snapshot || !task || !canReadTaskSpace(snapshot, context, task.spaceId)) return null
  return <InteractionScope key={`${taskSourceKey(snapshot, context)}:${task.id}:${task.createdAt}:${generation}`} active>
    <TaskDetails snapshot={snapshot} task={task} />
  </InteractionScope>
}

type DetailTab = 'details' | 'discussion' | 'activity'
const TITLE_DRAFT_FIELDS = ['title', 'baseTitle', 'editingTitle']
const DESCRIPTION_DRAFT_FIELDS = ['description', 'baseDescription', 'editingDescription']

function TaskDetails({ snapshot, task }: { snapshot: CruxSnapshot; task: CruxTask }): JSX.Element | null {
  const context = useCrux((state) => state.workspaceContext)
  const busy = useCrux((state) => state.busy)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const { mutate, error, pending } = useTaskMutation(source)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<DetailTab>('details')
  const [resourceRefresh, setResourceRefresh] = useState(0)
  const [materialRefresh, setMaterialRefresh] = useState(0)
  const draft = useTaskDraft(snapshot, context, { kind: 'details', spaceId: task.spaceId, task })
  const [title, setTitle] = useTaskDraftField(draft, 'title', task.title)
  const [baseTitle, setBaseTitle] = useTaskDraftField(draft, 'baseTitle', task.title)
  const [description, setDescription] = useTaskDraftField(draft, 'description', task.description ?? '')
  const [baseDescription, setBaseDescription] = useTaskDraftField(draft, 'baseDescription', task.description ?? '')
  const [editingTitle, setEditingTitle] = useTaskDraftField(draft, 'editingTitle', false)
  const [editingDescription, setEditingDescription] = useTaskDraftField(draft, 'editingDescription', false)
  const [subtaskOpen, setSubtaskOpen] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const descriptionInput = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const propertiesRef = useRef<HTMLElement>(null)
  const inputsRef = useRef<HTMLDivElement>(null)
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
  const titleChanged = editingTitle && task.title !== baseTitle
  const descriptionChanged = editingDescription && (task.description ?? '') !== baseDescription
  const following = Boolean(actorId && task.followerIds.includes(actorId))
  const comments = snapshot.comments.filter((comment) => comment.taskId === task.id)
  const activities = snapshot.activities.filter((activity) => activity.taskId === task.id)
  const close = (): void => { if (source.owns()) useCrux.getState().openTask(null) }
  const saveTitle = async (): Promise<void> => {
    if (disabled || titleChanged || !title.trim()) return
    const acknowledge = draft.acknowledge(TITLE_DRAFT_FIELDS)
    const result = await mutate('保存任务标题', async () => {
      if (useCrux.getState().snapshot?.tasks.find((item) => item.id === task.id)?.title !== baseTitle) return { ok: false as const, error: '标题已更新，请先核对当前标题。草稿已保留。' }
      const result = await api.crux.updateTask({ id: task.id, patch: { title: title.trim() } })
      if (result.ok) acknowledge()
      return result
    })
    if (result) titleInput.current?.blur()
  }
  const saveDescription = async (): Promise<void> => {
    if (disabled || descriptionChanged) return
    const acknowledge = draft.acknowledge(DESCRIPTION_DRAFT_FIELDS)
    const result = await mutate('保存任务描述', async () => {
      if ((useCrux.getState().snapshot?.tasks.find((item) => item.id === task.id)?.description ?? '') !== baseDescription) return { ok: false as const, error: '描述已更新，请先核对当前描述。草稿已保留。' }
      const result = await api.crux.updateTask({ id: task.id, patch: { description } })
      if (result.ok) acknowledge()
      return result
    })
    if (result) descriptionInput.current?.blur()
  }
  const removeTask = async (): Promise<void> => {
    const ticket = source.ticket()
    if (disabled || !source.canWrite(ticket)) return
    const confirmed = await confirmDialog({ title: `删除任务「${task.title}」？`, message: '任务及其评论会被删除，已有子任务将保留。', confirmText: '删除任务', danger: true }, source.signal)
    if (confirmed && source.canWrite(ticket)) await mutate('删除任务', () => api.crux.removeTask({ id: task.id }))
  }
  return <Modal open onClose={close} width={expanded ? '100%' : 1120} ariaLabel={`${task.id} · ${task.title}`}>
    <div className="collab-task-detail flex min-h-0 flex-col bg-my-canvas" data-expanded={expanded || undefined} style={{ height: 'var(--my-modal-max-height)' }}>
      <PageLayout variant="full" className="collab-task-detail-layout" style={{ height: 'auto', background: 'inherit' }}>
        <header className="collab-task-detail-header flex shrink-0 flex-wrap items-center gap-2 border-b border-my-line px-4">
        <span className="min-w-0 truncate text-my-xs text-my-tertiary">{space.name}</span><span className="shrink-0 text-my-sm text-my-secondary">{task.id}</span>
        <span className="collab-task-source-chip">{context.state === 'local' ? '本机任务' : '团队任务'}</span>
        <StatusBadge status={statusOf(snapshot, task.statusId)} />
        {task.workflow && <span className="collab-task-stage-chip">{task.workflow.stage === 'done' ? '已完成' : task.triagePending ? '待分拣' : getTaskStageLabel(task.workflow.stage)}</span>}
        <PriorityBadge priority={task.priority} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip label={following ? '取消关注' : '关注任务'}><Button size="sm" variant="ghost" disabled={disabled || !actorId} aria-label={following ? '取消关注任务' : '关注任务'} aria-pressed={following} onClick={() => { if (actorId) void mutate('更新任务关注', () => api.crux.updateTask({ id: task.id, patch: { followerToggle: actorId } })) }}><Star size={15} className={following ? 'fill-current' : ''} /></Button></Tooltip>
          <Tooltip label={expanded ? '收起详情' : '展开详情'}><Button size="sm" variant="ghost" aria-label={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Button></Tooltip>
          <Dropdown align="right" width={170} trigger={({ toggle, open }) => <Tooltip label="更多任务操作"><Button size="sm" variant="ghost" aria-label="更多任务操作" aria-expanded={open} aria-haspopup="true" onClick={toggle}><MoreHorizontal size={16} /></Button></Tooltip>}>
            {(dismiss) => <DropdownItem danger disabled={disabled} icon={<Trash2 size={14} />} onClick={() => { dismiss(); void removeTask() }}>删除任务</DropdownItem>}
          </Dropdown>
          <Tooltip label="关闭详情"><Button size="sm" variant="ghost" aria-label="关闭详情" onClick={close}><X size={16} /></Button></Tooltip>
        </div>
        </header>
        <PageContent variant="full" className="collab-task-detail-frame" style={{ padding: 0 }}>
          <div ref={bodyRef} className="collab-task-detail-body my-scrollbar">
          <div className="collab-task-detail-content">
        {space.archived && <p role="status" className="border-b border-my-line px-4 py-2 text-my-xs text-my-tertiary">空间已停用 · 只读</p>}
        {error && <p role="alert" className="collab-inline-error mx-4 mt-3">{error}</p>}
        <div ref={contentRef} tabIndex={-1} className="collab-task-detail-tabs flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-my-line px-4 py-2" aria-label="任务内容"><Tabs<DetailTab> tabs={[{ id: 'details', label: '工作区' }, { id: 'discussion', label: '讨论', count: comments.length }, { id: 'activity', label: '动态', count: activities.length }]} active={tab} onChange={setTab} /><Button size="sm" variant="ghost" onClick={() => { propertiesRef.current?.focus({ preventScroll: true }); propertiesRef.current?.scrollIntoView({ block: 'start' }) }}>属性</Button></div>
        <div className="collab-task-detail-scroll my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <section hidden={tab !== 'details'} aria-label="任务详情">
            <InteractionScope active={tab === 'details'}><div className="flex min-w-0 flex-col gap-5">
              <TaskWorkflow snapshot={snapshot} task={task} resourceRefresh={resourceRefresh} onMaterialCommitted={() => { if (source.owns()) { setMaterialRefresh((value) => value + 1); setResourceRefresh((value) => value + 1) } }} onOpenInputs={sharedInputs ? () => { if (source.owns()) { inputsRef.current?.focus({ preventScroll: true }); inputsRef.current?.scrollIntoView({ block: 'start' }) } } : undefined} />
              <TaskCodeResources task={task} onSelected={() => setResourceRefresh((value) => value + 1)} />
              {tab === 'details' && <TaskProgressPanel snapshot={snapshot} task={task} />}
              <TaskCreationReferences taskId={task.id} spaceId={space.id} />
              <section>
                {editingTitle ? <div className="flex flex-col gap-2"><Field label="标题"><input ref={titleInput} autoFocus className={inputClass} disabled={disabled} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void saveTitle() } }} /></Field>{titleChanged && <div role="alert" className="collab-inline-error"><span>当前标题：{task.title}</span><Button size="sm" disabled={disabled} onClick={() => setBaseTitle(task.title)}>已核对，保留草稿</Button></div>}<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={disabled} onClick={() => draft.acknowledge(TITLE_DRAFT_FIELDS)()}>取消</Button><Button size="sm" variant="primary" disabled={disabled || titleChanged || !title.trim()} onClick={() => void saveTitle()}>保存标题</Button></div></div> : <div className="flex items-start gap-2"><h2 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-my-title font-semibold text-my-primary">{task.title}</h2><Tooltip label="编辑标题"><Button size="sm" variant="ghost" disabled={disabled} aria-label="编辑标题" onClick={() => { setTitle(task.title); setBaseTitle(task.title); setEditingTitle(true) }}><Pencil size={14} /></Button></Tooltip></div>}
              </section>
              <section>
                <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-my-sm font-medium text-my-primary">描述</h3>{!editingDescription && <Tooltip label="编辑描述"><Button size="sm" variant="ghost" disabled={disabled} aria-label="编辑描述" onClick={() => { setDescription(task.description ?? ''); setBaseDescription(task.description ?? ''); setEditingDescription(true) }}><Pencil size={14} /></Button></Tooltip>}</div>
                {editingDescription ? <div className="flex flex-col gap-2"><textarea ref={descriptionInput} autoFocus aria-label="任务描述" disabled={disabled} className={textareaClass} rows={6} value={description} onChange={(event) => setDescription(event.target.value)} />{descriptionChanged && <div role="alert" className="collab-inline-error"><details className="w-full"><summary>描述已更新，查看当前内容</summary><p className="whitespace-pre-wrap break-words">{task.description || '暂无描述'}</p></details><Button size="sm" disabled={disabled} onClick={() => setBaseDescription(task.description ?? '')}>已核对，保留草稿</Button></div>}<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={disabled} onClick={() => draft.acknowledge(DESCRIPTION_DRAFT_FIELDS)()}>取消</Button><Button size="sm" variant="primary" disabled={disabled || descriptionChanged} onClick={() => void saveDescription()}>保存描述</Button></div></div> : <p className={`whitespace-pre-wrap break-words text-my-sm leading-relaxed ${task.description ? 'text-my-secondary' : 'text-my-tertiary'}`}>{task.description || '暂无描述'}</p>}
              </section>
              {sharedInputs && <div ref={inputsRef} tabIndex={-1}><TaskInputPanel key={`${taskSourceKey(snapshot, context)}:${space.id}:${task.id}:${task.createdAt}`} api={governanceApi} workspaceKey={context.key} spaceId={space.id} taskId={task.id} taskCreatedAt={task.createdAt} actorId={actorId} materialsApi={materialsApi} refreshRevision={materialRefresh} workspaceRevision={context.revision} canAdopt={canAdoptInputs} onAdopted={() => { if (source.owns()) setResourceRefresh((value) => value + 1) }} /></div>}
              {Boolean(task.acceptanceCriteria?.length) && <section><h3 className="mb-2 text-my-sm font-medium text-my-primary">验收标准</h3><ol className="list-decimal space-y-2 pl-5 text-my-sm text-my-secondary">{task.acceptanceCriteria?.map((criterion, index) => <li key={index} className="whitespace-pre-wrap break-words">{criterion}</li>)}</ol></section>}
              <div className="border-t border-my-line pt-4"><TaskLinks snapshot={snapshot} task={task} disabled={disabled} source={source} mutate={mutate} onNewSubtask={() => setSubtaskOpen(true)} /></div>
              <p className="text-my-xs text-my-tertiary">创建于 {formatCollaborationTime(task.createdAt)} · 更新于 {formatCollaborationTime(task.updatedAt)}</p>
            </div></InteractionScope>
          </section>
          <section hidden={tab !== 'discussion'} aria-label="讨论"><InteractionScope active={tab === 'discussion'}><TaskDiscussion snapshot={snapshot} task={task} actorId={actorId} disabled={disabled} mutate={mutate} /></InteractionScope></section>
          <section hidden={tab !== 'activity'} aria-label="动态"><ol className="space-y-4">{activities.map((activity) => <li key={activity.id} className="flex flex-col gap-1 text-my-sm"><span className="whitespace-pre-wrap break-words text-my-secondary">{activity.text}</span><time dateTime={activity.at} className="text-my-xs text-my-tertiary">{formatCollaborationTime(activity.at)}</time></li>)}</ol>{!activities.length && <p className="text-my-sm text-my-tertiary">暂无动态</p>}</section>
        </div>
          </div>
          <aside ref={propertiesRef} tabIndex={-1} className="collab-task-detail-properties my-scrollbar" aria-label="任务属性区域">
            <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-my-xs font-medium text-my-tertiary">任务属性</h3><Button size="sm" variant="ghost" onClick={() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; contentRef.current?.focus({ preventScroll: true }) }}>返回内容</Button></div>
            <TaskProperties snapshot={snapshot} task={task} disabled={disabled} actorId={actorId} source={source} mutate={mutate} />
          </aside>
          </div>
        </PageContent>
      </PageLayout>
      <NewTaskModal open={subtaskOpen} onClose={() => setSubtaskOpen(false)} spaceId={task.spaceId} parentTaskId={task.id} projectId={task.projectId} iterationId={task.iterationIds[0]} />
    </div>
  </Modal>
}
