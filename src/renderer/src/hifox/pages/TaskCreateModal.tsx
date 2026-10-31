import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { HifoxID, HifoxPriority, HifoxSnapshot, HifoxTaskInput, HifoxTaskWorkKind } from '@shared/hifox'
import { hifoxTaskWorkKindSchema } from '@shared/hifox-schema'
import { api, hasIpc } from '../../api'
import { Button, Modal, Tooltip } from '../../my/ui'
import { InteractionScope } from '../../utils/interaction-scope'
import { PRIORITY_LABEL, useHifox, visibleLabels } from '../store'
import { Field, inputClass, textareaClass } from '../ui'
import { TaskAllocationPicker, type TaskAllocation } from './task-detail/TaskAllocationPicker'
import { canReadTaskSpace, taskActorId, taskSourceKey, useTaskMutation, useTaskSource, useTaskSurfaceGeneration } from './task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from './task-detail/task-drafts'
import { RequirementIntake } from '../intake/RequirementIntake'
import { discussionInput } from '../intake/requirements'
import type { IntakeFile } from '../intake/use-requirement-intake'

export interface NewTaskModalProps {
  open: boolean
  onClose: () => void
  spaceId?: HifoxID
  projectId?: HifoxID
  iterationId?: HifoxID
  parentTaskId?: HifoxID
  triagePending?: boolean
}

const WORK_KIND_LABELS: Record<HifoxTaskWorkKind, string> = { code: '研发工作', general: '日常工作' }

export function NewTaskModal(props: NewTaskModalProps): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const context = useHifox((state) => state.workspaceContext)
  const generation = useTaskSurfaceGeneration(true)
  const spaceId = props.spaceId ?? currentSpaceId
  if (!props.open) return null
  if (!snapshot || !spaceId || !canReadTaskSpace(snapshot, context, spaceId)) return <Modal open onClose={props.onClose} ariaLabel="无法创建任务"><div className="flex flex-col gap-3 p-5"><h2 className="text-my-md font-semibold text-my-primary">当前空间不可用</h2><p role="alert" className="text-my-sm text-my-secondary">请重新选择有访问权限的空间。</p><div className="flex justify-end"><Button onClick={props.onClose}>关闭</Button></div></div></Modal>
  const key = JSON.stringify([taskSourceKey(snapshot, context), spaceId, props.projectId, props.iterationId, props.parentTaskId, props.triagePending, generation])
  return <InteractionScope key={key} active><TaskCreateForm {...props} snapshot={snapshot} spaceId={spaceId} /></InteractionScope>
}

function TaskCreateForm({ snapshot, spaceId, onClose, parentTaskId: initialParent, projectId: initialProject, iterationId: initialIteration, triagePending: explicitTriage }: NewTaskModalProps & { snapshot: HifoxSnapshot; spaceId: string }): JSX.Element | null {
  const context = useHifox((state) => state.workspaceContext)
  const busy = useHifox((state) => state.busy)
  const source = useTaskSource({ spaceId, taskId: initialParent, creating: true })
  const { mutate, error, pending } = useTaskMutation(source)
  const types = snapshot.taskTypes.filter((type) => type.spaceId === spaceId)
  const draft = useTaskDraft(snapshot, context, { kind: 'create', spaceId, task: snapshot.tasks.find((task) => task.id === initialParent), creationContext: [initialParent, initialProject, initialIteration, explicitTriage] })
  const [title, setTitle] = useTaskDraftField(draft, 'title', '')
  const [description, setDescription] = useTaskDraftField(draft, 'description', '')
  const [criteria, setCriteria] = useTaskDraftField(draft, 'criteria', '')
  const [workKind, setWorkKind] = useTaskDraftField<HifoxTaskWorkKind>(draft, 'workKind', 'code')
  const [typeId, setTypeId] = useTaskDraftField(draft, 'typeId', types.find((type) => type.isDefault)?.id ?? types[0]?.id ?? '')
  const [priority, setPriority] = useTaskDraftField<HifoxPriority>(draft, 'priority', 'none')
  const [allocation, setAllocation] = useTaskDraftField<TaskAllocation>(draft, 'allocation', { assigneeIds: [], executor: null })
  const [labelIds, setLabelIds] = useTaskDraftField<string[]>(draft, 'labelIds', [])
  const [projectId, setProjectId] = useTaskDraftField(draft, 'projectId', initialProject ?? '')
  const [iterationId, setIterationId] = useTaskDraftField(draft, 'iterationId', explicitTriage === true ? '' : initialIteration ?? '')
  const [parentTaskId, setParentTaskId] = useTaskDraftField(draft, 'parentTaskId', initialParent ?? '')
  const [creationMode, setCreationMode] = useTaskDraftField<'ai' | 'manual'>(draft, 'creationMode', !initialParent && context.state !== 'local' ? 'ai' : 'manual')
  const [intakeOriginal] = useTaskDraftField(draft, 'intakeOriginal', '')
  const [intakeFiles] = useTaskDraftField<IntakeFile[]>(draft, 'intakeFiles', [])
  const space = snapshot.spaces.find((candidate) => candidate.id === spaceId)
  if (!space || !source.available) return null
  const actorId = taskActorId(snapshot, context)
  const canAct = Boolean(actorId && space.memberIds.includes(actorId))
  const disabled = busy || pending || !hasIpc || Boolean(space.archived) || !canAct
  const triagePending = explicitTriage ?? (!iterationId && !parentTaskId)
  const labels = visibleLabels(snapshot, spaceId)
  const iterations = snapshot.iterations.filter((iteration) => iteration.spaceId === spaceId && iteration.status !== 'completed')
  const needsFallback = Boolean(allocation.executor && !allocation.assigneeIds.some((id) => space.memberIds.includes(id)))
  const heading = initialParent ? '新建子任务' : triagePending ? '新建待分拣任务' : '新建任务'
  const close = (): void => { if (source.owns()) onClose() }
  const submit = async (): Promise<void> => {
    if (disabled || !title.trim() || needsFallback || !actorId) return
    const input: HifoxTaskInput = {
      spaceId, creatorId: actorId, title: title.trim(), description: description.trim() || undefined,
      workKind, acceptanceCriteria: criteria.split(/\r?\n/).map((criterion) => criterion.trim()).filter(Boolean),
      typeId: typeId || undefined, priority, assigneeIds: allocation.assigneeIds, executor: allocation.executor,
      labelIds, projectId: projectId || undefined, iterationIds: triagePending ? [] : iterationId ? [iterationId] : [],
      parentTaskId: parentTaskId || undefined, triagePending
    }
    const acknowledge = draft.acknowledge()
    const result = await mutate('新建任务', async () => { const result = await api.hifox.createTask(input); if (result.ok) acknowledge(); return result })
    if (result) { onClose(); useHifox.getState().openTask(result.taskId) }
  }
  if (creationMode === 'ai' && actorId) return <RequirementIntake snapshot={snapshot} spaceId={spaceId} actorId={actorId} draft={draft} onClose={close} onManual={() => {
    if (!source.canWrite()) return
    if (!title.trim() && intakeOriginal.trim()) setTitle(intakeOriginal.trim().split('\n')[0].slice(0, 160))
    if (!description.trim() && (intakeOriginal.trim() || intakeFiles.length)) setDescription(discussionInput(intakeOriginal, intakeFiles, '', ''))
    setCreationMode('manual')
  }} />
  return <Modal open onClose={close} ariaLabel={heading}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col bg-my-canvas">
      <header className="flex h-my-header shrink-0 items-center gap-2 border-b border-my-line px-4"><h2 className="min-w-0 flex-1 truncate text-my-md font-semibold text-my-primary">{heading}</h2>{!initialParent && context.state !== 'local' && <Button size="sm" variant="ghost" onClick={() => setCreationMode('ai')}>从诉求和资料整理</Button>}<span className="text-my-xs text-my-tertiary">{space.key}</span><Tooltip label="关闭新建任务"><Button size="sm" variant="ghost" aria-label="关闭新建任务" onClick={close}><X size={16} /></Button></Tooltip></header>
      <div className="my-scrollbar min-h-0 overflow-y-auto p-4">
        {space.archived && <p role="alert" className="mb-3 text-my-sm text-my-secondary">空间已停用，恢复后才能创建任务。</p>}
        {!canAct && <p role="alert" className="mb-3 text-my-sm text-my-secondary">当前身份不是该空间成员，无法创建任务。</p>}
        {error && <p role="alert" className="collab-inline-error mb-3">{error}</p>}
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4 border-0 p-0" onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }}>
          <Field label="标题"><input autoFocus required className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="要做什么？" /></Field>
          <Field label="描述"><textarea className={textareaClass} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
          <Field label="验收标准"><textarea className={textareaClass} rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="工作内容"><select className={inputClass} value={workKind} onChange={(event) => setWorkKind(event.target.value as HifoxTaskWorkKind)}>{hifoxTaskWorkKindSchema.options.map((kind) => <option key={kind} value={kind}>{WORK_KIND_LABELS[kind]}</option>)}</select></Field>
            <Field label="类型"><select className={inputClass} value={typeId} onChange={(event) => setTypeId(event.target.value)}><option value="">默认类型</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></Field>
            <Field label="优先级"><select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value as HifoxPriority)}>{(Object.keys(PRIORITY_LABEL) as HifoxPriority[]).map((value) => <option key={value} value={value}>{PRIORITY_LABEL[value]}</option>)}</select></Field>
          </div>
          <Field label="版本"><select className={inputClass} disabled={explicitTriage === true} value={iterationId} onChange={(event) => setIterationId(event.target.value)}><option value="">未排期</option>{iterations.map((iteration) => <option key={iteration.id} value={iteration.id}>{iteration.name}</option>)}</select></Field>
          <details><summary className="cursor-pointer text-my-xs font-medium text-my-secondary">更多属性</summary><div className="mt-3 flex flex-col gap-3">
            <section><h3 className="mb-1 text-my-xs font-medium text-my-tertiary">分工</h3><TaskAllocationPicker snapshot={snapshot} spaceId={spaceId} value={allocation} onChange={setAllocation} fallbackActorId={actorId} disabled={disabled} /></section>
            <Field label="专项"><select className={inputClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">无专项</option>{snapshot.projects.filter((project) => project.spaceId === spaceId && project.status === 'active').map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
            <Field label="父任务"><select className={inputClass} value={parentTaskId} onChange={(event) => setParentTaskId(event.target.value)}><option value="">无父任务</option>{snapshot.tasks.filter((task) => task.spaceId === spaceId).map((task) => <option key={task.id} value={task.id}>{task.id} · {task.title}</option>)}</select></Field>
            {labels.length > 0 && <section><h3 className="mb-1 text-my-xs font-medium text-my-tertiary">标签</h3><div className="flex flex-wrap gap-1.5">{labels.map((label) => <Button key={label.id} size="sm" variant={labelIds.includes(label.id) ? 'neutral' : 'outline'} aria-pressed={labelIds.includes(label.id)} onClick={() => setLabelIds((current) => current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id])}>{label.name}</Button>)}</div></section>}
          </div></details>
        </fieldset>
        {needsFallback && <p role="alert" className="mt-3 text-my-xs text-my-secondary">请为 Agent 或小队选择一名兜底处理人。</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-my-line px-4 py-3">{draft.hasDraft && <Button size="sm" variant="ghost" className="mr-auto" disabled={busy || pending} onClick={() => { if (source.owns()) { draft.discard(); onClose() } }}>放弃草稿</Button>}<Button size="sm" variant="ghost" onClick={close}>取消</Button><Tooltip label={explicitTriage === true ? '先进入分拣，接纳后可安排版本' : 'Ctrl+Enter 或 Command+Enter 创建'} wrap><Button size="sm" variant="primary" disabled={disabled || !title.trim() || needsFallback} onClick={() => void submit()}>{pending ? '创建中…' : '创建任务'}</Button></Tooltip></footer>
    </div>
  </Modal>
}
