import { useRef, useState, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import type { CruxPriority, CruxSnapshot, CruxTask, CruxTaskPatchInput } from '@shared/crux'
import { api } from '../../../api'
import { Button, Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../../../my/ui'
import { allowedStatusIdsFor, memberOf, PRIORITY_LABEL, useCrux, visibleLabels } from '../../store'
import { Field, LabelChip, MemberChip, Select } from '../../ui'
import { TaskAllocationPicker } from './TaskAllocationPicker'
import type { TaskMutation, TaskSourceOwner } from './use-task-source'

interface TaskPropertiesProps {
  snapshot: CruxSnapshot
  task: CruxTask
  disabled: boolean
  actorId?: string
  source: TaskSourceOwner
  mutate: TaskMutation
}

export function TaskProperties({ snapshot, task, disabled, actorId, source, mutate }: TaskPropertiesProps): JSX.Element {
  const [draft, setDraft] = useState<CruxTaskPatchInput>({})
  const draftRef = useRef(draft)
  const save = async (attempt: CruxTaskPatchInput): Promise<void> => {
    const result = await mutate('更新任务属性', () => api.crux.updateTask({ id: task.id, patch: attempt }))
    if (!result) return
    const next = { ...draftRef.current }
    for (const key of Object.keys(attempt) as Array<keyof CruxTaskPatchInput>) {
      if (JSON.stringify(next[key]) === JSON.stringify(attempt[key])) delete next[key]
    }
    draftRef.current = next
    setDraft(next)
  }
  const change = (input: CruxTaskPatchInput): void => {
    if (disabled || !source.canWrite()) return
    const next = { ...draftRef.current, ...input }
    draftRef.current = next
    setDraft(next)
    void save(next)
  }
  const managed = Boolean(task.workflow)
  const allowed = allowedStatusIdsFor(snapshot, task.spaceId, (draft.typeId === undefined ? task.typeId : draft.typeId) ?? undefined)
  const statuses = snapshot.taskStatuses.filter((status) => status.spaceId === task.spaceId && allowed.has(status.id)).sort((a, b) => a.order - b.order)
  const types = snapshot.taskTypes.filter((type) => type.spaceId === task.spaceId)
  const visible = visibleLabels(snapshot, task.spaceId)
  const labels = snapshot.taskLabels.filter((label) => visible.some((candidate) => candidate.id === label.id) || task.labelIds.includes(label.id))
  const labelIds = draft.labelIds ?? task.labelIds
  const parentId = draft.parentTaskId === undefined ? task.parentTaskId : draft.parentTaskId
  const parent = snapshot.tasks.find((candidate) => candidate.id === parentId)
  const descendants = new Set([task.id])
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of snapshot.tasks) {
      if (candidate.parentTaskId && descendants.has(candidate.parentTaskId) && !descendants.has(candidate.id)) { descendants.add(candidate.id); changed = true }
    }
  }
  const parents = snapshot.tasks.filter((candidate) => candidate.spaceId === task.spaceId && !descendants.has(candidate.id))
  const handlerId = task.workflow ? task.workflow.handlerId : task.assigneeIds[0]
  const handler = memberOf(snapshot, handlerId)
  const hasDraft = Object.keys(draft).length > 0
  return <div className="flex min-w-0 flex-col gap-4" aria-label="任务属性">
    {!managed && <Field label="状态"><Select disabled={disabled} value={draft.statusId ?? task.statusId} onChange={(value) => change({ statusId: value })} options={statuses.map((status) => ({ value: status.id, label: status.name }))} /></Field>}
    <Field label="优先级"><Select disabled={disabled} value={draft.priority ?? task.priority} onChange={(value) => change({ priority: value as CruxPriority })} options={(Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((priority) => ({ value: priority, label: PRIORITY_LABEL[priority] }))} /></Field>
    <Field label="类型"><Select disabled={disabled} value={(draft.typeId === undefined ? task.typeId : draft.typeId) ?? ''} onChange={(value) => change({ typeId: value || null })} options={[{ value: '', label: '默认类型' }, ...types.map((type) => ({ value: type.id, label: type.name }))]} /></Field>
    <Tooltip label={task.triagePending ? '通过阶段操作接纳任务后再安排版本' : '更改任务所属版本'} wrap><span className="w-full"><Field label="版本"><Select disabled={disabled || task.triagePending} value={(draft.iterationIds ?? task.iterationIds)[0] ?? ''} onChange={(value) => change({ iterationIds: value ? [value] : [] })} options={[{ value: '', label: '未排期' }, ...snapshot.iterations.filter((iteration) => iteration.spaceId === task.spaceId && (iteration.status !== 'completed' || task.iterationIds.includes(iteration.id))).map((iteration) => ({ value: iteration.id, label: `${iteration.name}${iteration.status === 'completed' ? '（已完成）' : ''}` }))]} /></Field></span></Tooltip>
    <section><h3 className="mb-1 text-my-xs font-medium text-my-tertiary">当前处理人</h3>{handler ? <MemberChip member={handler} /> : <p className="text-my-sm text-my-secondary">{handlerId ? '成员不可用' : '未分配'}</p>}</section>
    <section><h3 className="mb-1 text-my-xs font-medium text-my-tertiary">分工</h3><TaskAllocationPicker snapshot={snapshot} spaceId={task.spaceId} value={{ assigneeIds: draft.assigneeIds ?? task.assigneeIds, executor: draft.executor === undefined ? task.executor ?? null : draft.executor }} onChange={(value) => change(value)} fallbackActorId={actorId} disabled={disabled} managed={managed} /></section>
    <section><h3 className="mb-1 text-my-xs font-medium text-my-tertiary">标签</h3>
      <Dropdown width={240} trigger={({ toggle, open }) => <Button size="sm" variant="outline" disabled={disabled} aria-expanded={open} aria-haspopup="true" aria-label="编辑任务标签" className="w-full justify-between" onClick={toggle}><span className="min-w-0 truncate">{labelIds.length ? `${labelIds.length} 个标签` : '无标签'}</span><ChevronDown size={14} aria-hidden="true" /></Button>}>
        {() => <div className="my-scrollbar max-h-64 overflow-y-auto"><DropdownHeader>标签</DropdownHeader>{labels.map((label) => <DropdownItem key={label.id} selected={labelIds.includes(label.id)} disabled={disabled || label.archived && !labelIds.includes(label.id)} onClick={() => change({ labelIds: labelIds.includes(label.id) ? labelIds.filter((id) => id !== label.id) : [...labelIds, label.id] })}>{label.name}{label.archived ? '（已归档）' : ''}</DropdownItem>)}{!labels.length && <DropdownItem disabled>暂无标签</DropdownItem>}</div>}
      </Dropdown>
      {labelIds.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{labels.filter((label) => labelIds.includes(label.id)).map((label) => <LabelChip key={label.id} label={label} />)}</div>}
    </section>
    <Field label="专项"><Select disabled={disabled} value={(draft.projectId === undefined ? task.projectId : draft.projectId) ?? ''} onChange={(value) => change({ projectId: value || null })} options={[{ value: '', label: '无专项' }, ...snapshot.projects.filter((project) => project.spaceId === task.spaceId && (project.status === 'active' || project.id === task.projectId)).map((project) => ({ value: project.id, label: project.name }))]} /></Field>
    <Field label="父任务"><Select disabled={disabled} value={parentId ?? ''} onChange={(value) => change({ parentTaskId: value || null })} options={[{ value: '', label: '无父任务' }, ...parents.map((candidate) => ({ value: candidate.id, label: `${candidate.id} · ${candidate.title}` }))]} /></Field>
    {parent && <Button size="sm" variant="ghost" className="justify-start" onClick={() => { if (source.owns()) useCrux.getState().openTask(parent.id) }}>打开父任务 {parent.id}</Button>}
    {hasDraft && <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => void save(draftRef.current)}>重试保存</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={() => { draftRef.current = {}; setDraft({}) }}>还原属性</Button></div>}
    <dl className="border-t border-my-line pt-3 text-my-xs text-my-tertiary"><dt>创建人</dt><dd className="mt-1 text-my-secondary">{memberOf(snapshot, task.creatorId)?.name ?? '—'}</dd></dl>
  </div>
}
