import { useState, type JSX } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask, CruxTaskRelationKind } from '@shared/crux'
import { api } from '../../../api'
import { Button, Tooltip } from '../../../my/ui'
import { statusOf, useCrux } from '../../store'
import { inputClass, StatusBadge, Select } from '../../ui'
import { canReadTaskSpace, type TaskMutation, type TaskSourceOwner } from './use-task-source'

type RelationKind = CruxTaskRelationKind | 'blocked_by'

export function TaskLinks({ snapshot, task, disabled, source, mutate, onNewSubtask }: {
  snapshot: CruxSnapshot
  task: CruxTask
  disabled: boolean
  source: TaskSourceOwner
  mutate: TaskMutation
  onNewSubtask: () => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [targetId, setTargetId] = useState('')
  const [kind, setKind] = useState<RelationKind>('related')
  const subtasks = snapshot.tasks.filter((candidate) => candidate.parentTaskId === task.id)
  const relations = [...task.relations]
  for (const candidate of snapshot.tasks) {
    const incoming = candidate.relations.find((relation) => relation.taskId === task.id)
    if (incoming && !relations.some((relation) => relation.taskId === candidate.id)) relations.push({ kind: incoming.kind, taskId: candidate.id })
  }
  const relatedIds = new Set(relations.map((relation) => relation.taskId))
  const context = useCrux((state) => state.workspaceContext)
  const candidates = snapshot.tasks.filter((candidate) => candidate.id !== task.id && !relatedIds.has(candidate.id) &&
    canReadTaskSpace(snapshot, context, candidate.spaceId) && !snapshot.spaces.find((space) => space.id === candidate.spaceId)?.archived &&
    `${candidate.id} ${candidate.title}`.toLowerCase().includes(search.toLowerCase()))
  const navigate = (id: string): void => {
    const current = useCrux.getState()
    const target = current.snapshot?.tasks.find((candidate) => candidate.id === id)
    if (source.owns() && target && current.snapshot && canReadTaskSpace(current.snapshot, current.workspaceContext, target.spaceId)) current.openTask(id)
  }
  const add = async (): Promise<void> => {
    if (disabled || !targetId || !candidates.some((candidate) => candidate.id === targetId)) return
    const submitted = { search, targetId }
    const result = await mutate('添加关联', () => api.crux.addRelation(kind === 'blocked_by'
      ? { taskId: targetId, relation: { kind: 'blocks', taskId: task.id } }
      : { taskId: task.id, relation: { kind, taskId: targetId } }))
    if (result) { setTargetId((current) => current === submitted.targetId ? '' : current); setSearch((current) => current === submitted.search ? '' : current); setAdding(false) }
  }
  return <div className="flex flex-col gap-5">
    <section aria-label="子任务">
      <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-my-sm font-medium text-my-primary">子任务 <span className="text-my-xs text-my-tertiary">{subtasks.length}</span></h3><Tooltip label="新建子任务"><Button size="sm" variant="ghost" disabled={disabled} aria-label="新建子任务" onClick={onNewSubtask}><Plus size={14} /></Button></Tooltip></div>
      <ul className="space-y-2">{subtasks.map((subtask) => <li key={subtask.id} className="flex items-center gap-2"><button type="button" className="min-w-0 flex-1 truncate text-left text-my-sm text-my-secondary hover:underline" onClick={() => navigate(subtask.id)}>{subtask.id} · {subtask.title}</button><StatusBadge status={statusOf(snapshot, subtask.statusId)} /><Tooltip label="解除父子关系"><Button size="sm" variant="ghost" disabled={disabled} aria-label={`移除子任务 ${subtask.id}`} onClick={() => void mutate('解除子任务', () => api.crux.updateTask({ id: subtask.id, patch: { parentTaskId: null } }))}><Trash2 size={14} /></Button></Tooltip></li>)}</ul>
      {!subtasks.length && <p className="text-my-xs text-my-tertiary">暂无子任务</p>}
    </section>
    <section aria-label="关联任务">
      <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-my-sm font-medium text-my-primary">关联任务 <span className="text-my-xs text-my-tertiary">{relations.length}</span></h3><Tooltip label={adding ? '收起关联编辑' : '添加关联任务'}><Button size="sm" variant="ghost" disabled={disabled} aria-label={adding ? '收起关联编辑' : '添加关联任务'} aria-expanded={adding} onClick={() => setAdding((current) => !current)}>{adding ? <X size={14} /> : <Plus size={14} />}</Button></Tooltip></div>
      <ul className="space-y-2">{relations.map((relation) => {
        const target = snapshot.tasks.find((candidate) => candidate.id === relation.taskId)
        const readable = target && canReadTaskSpace(snapshot, context, target.spaceId)
        const incomingBlock = target?.relations.some((candidate) => candidate.kind === 'blocks' && candidate.taskId === task.id)
        return <li key={relation.taskId} className="flex items-center gap-2"><span className="shrink-0 text-my-xs text-my-tertiary">{incomingBlock ? '受阻于' : relation.kind === 'blocks' ? '阻塞' : relation.kind === 'duplicate' ? '重复' : '相关'}</span>{readable ? <><button type="button" className="min-w-0 flex-1 truncate text-left text-my-sm text-my-secondary hover:underline" onClick={() => navigate(target.id)}>{target.id} · {target.title}</button><StatusBadge status={statusOf(snapshot, target.statusId)} /></> : <span className="flex-1 text-my-xs text-my-tertiary">任务不可用</span>}<Tooltip label="移除关联"><Button size="sm" variant="ghost" disabled={disabled} aria-label={readable ? `移除关联 ${target.id}` : '移除不可用任务的关联'} onClick={() => void mutate('移除关联', () => api.crux.removeRelation({ taskId: task.id, targetTaskId: relation.taskId }))}><Trash2 size={14} /></Button></Tooltip></li>
      })}</ul>
      {!relations.length && <p className="text-my-xs text-my-tertiary">暂无关联任务</p>}
      {adding && <fieldset disabled={disabled} className="mt-3 flex min-w-0 flex-col gap-2 rounded-my-base border border-my-line p-3">
        <input className={inputClass} aria-label="搜索关联任务" placeholder="搜索任务编号或标题" value={search} onChange={(event) => { setSearch(event.target.value); setTargetId('') }} />
        <Select
          className="w-full"
          ariaLabel="关联类型"
          value={kind}
          onChange={(val) => setKind(val as RelationKind)}
          options={[
            { value: 'related', label: '相关' },
            { value: 'blocks', label: '阻塞' },
            { value: 'blocked_by', label: '受阻于' },
            { value: 'duplicate', label: '重复' }
          ]}
        />
        <Select
          className="w-full"
          ariaLabel="关联任务"
          value={targetId}
          onChange={setTargetId}
          options={[
            { value: '', label: '选择任务' },
            ...candidates.map((candidate) => ({ value: candidate.id, label: `${candidate.id} · ${candidate.title}` }))
          ]}
        />
        <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>取消</Button><Button size="sm" disabled={!targetId} onClick={() => void add()}>添加关联</Button></div>
      </fieldset>}
    </section>
  </div>
}
