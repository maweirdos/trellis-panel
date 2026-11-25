import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useCrux, spaceTasks, applyTaskFilter, memberOf, statusOf, isTriagePending, visibleLabels, PRIORITY_LABEL } from '../store'
import { PageHeader, StatusBadge, PriorityBadge, LabelChip, MemberChip, ExecutorBadge, compactInputClass, Select } from '../ui'
import { NewTaskModal } from './TaskDetailDrawer'
import { Button, EmptyState, SearchInput } from '../../my/ui'
import type { CruxID, CruxPriority, CruxViewFilter } from '@shared/crux'

export function TaskFilters({ value, onChange }: { value?: CruxViewFilter; onChange?: (patch: Partial<CruxViewFilter>) => void } = {}): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const storedFilter = useCrux((s) => s.taskFilter)
  const storedSetFilter = useCrux((s) => s.setTaskFilter)
  const filter = value ?? storedFilter
  const setFilter = onChange ?? storedSetFilter
  if (!snapshot) return null
  const members = snapshot.members.filter((m) => snapshot.spaces.find((s) => s.id === spaceId)?.memberIds.includes(m.id))
  const labels = visibleLabels(snapshot, spaceId)
  const reset = (): void => setFilter({ keyword: undefined, typeIds: undefined, statusIds: undefined, labelIds: undefined, assigneeIds: undefined, priorities: undefined, projectId: undefined, iterationId: undefined })
  const toggle = (key: 'labelIds' | 'assigneeIds', id: string): void => {
    const previous = filter[key] ?? []
    setFilter({ [key]: previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id] })
  }
  const selected = 'my-control rounded-my-md border border-my-line-strong bg-my-layer-1-active px-2 py-1 text-my-xs text-my-primary'
  return <div className="flex flex-col gap-2" aria-label="任务筛选">
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput value={filter.keyword ?? ''} onChange={(keyword) => setFilter({ keyword })} placeholder="搜索任务编号或标题" />
      <Select
        size="sm"
        ariaLabel="筛选类型"
        value={filter.typeIds?.[0] ?? ''}
        onChange={(val) => setFilter({ typeIds: val ? [val] : undefined })}
        options={[
          { value: '', label: '全部类型' },
          ...snapshot.taskTypes.filter((t) => t.spaceId === spaceId).map((t) => ({ value: t.id, label: t.name }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选状态"
        value={filter.statusIds?.[0] ?? ''}
        onChange={(val) => setFilter({ statusIds: val ? [val] : undefined })}
        options={[
          { value: '', label: '全部状态' },
          ...snapshot.taskStatuses.filter((s) => s.spaceId === spaceId).sort((a, b) => a.order - b.order).map((s) => ({ value: s.id, label: s.name }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选优先级"
        value={filter.priorities?.[0] ?? ''}
        onChange={(val) => setFilter({ priorities: val ? [val as CruxPriority] : undefined })}
        options={[
          { value: '', label: '全部优先级' },
          ...(Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选处理人"
        value=""
        onChange={(val) => { if (val) toggle('assigneeIds', val) }}
        options={[
          { value: '', label: '选择处理人…' },
          ...members.map((m) => ({ value: m.id, label: `${m.name}${filter.assigneeIds?.includes(m.id) ? '（已选）' : ''}` }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选版本"
        value={filter.iterationId ?? ''}
        onChange={(val) => setFilter({ iterationId: val || undefined })}
        options={[
          { value: '', label: '全部版本' },
          ...snapshot.iterations.filter((it) => it.spaceId === spaceId).map((it) => ({ value: it.id, label: it.name }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选专项"
        value={filter.projectId ?? ''}
        onChange={(val) => setFilter({ projectId: val || undefined })}
        options={[
          { value: '', label: '全部专项' },
          ...snapshot.projects.filter((p) => p.spaceId === spaceId).map((p) => ({ value: p.id, label: p.name }))
        ]}
      />
      <Select
        size="sm"
        ariaLabel="筛选标签"
        value=""
        onChange={(val) => { if (val) toggle('labelIds', val) }}
        options={[
          { value: '', label: '选择标签（同时包含）…' },
          ...labels.map((l) => ({ value: l.id, label: `${l.name}${filter.labelIds?.includes(l.id) ? '（已选）' : ''}` }))
        ]}
      />
      <Button variant="ghost" size="sm" onClick={reset}>清除筛选</Button>
    </div>
    {(Boolean(filter.assigneeIds?.length) || Boolean(filter.labelIds?.length)) && <div className="flex flex-wrap gap-2">
      {filter.assigneeIds?.map((id) => <button key={id} type="button" className={selected} aria-label={`移除处理人筛选 ${memberOf(snapshot, id)?.name ?? id}`} onClick={() => toggle('assigneeIds', id)}>{memberOf(snapshot, id)?.name ?? id} ×</button>)}
      {filter.labelIds?.map((id) => <button key={id} type="button" className={selected} aria-label={`移除标签筛选 ${labels.find((l) => l.id === id)?.name ?? id}`} onClick={() => toggle('labelIds', id)}>{labels.find((l) => l.id === id)?.name ?? id} ×</button>)}
    </div>}
  </div>
}

export function TasksPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const filter = useCrux((s) => s.taskFilter)
  const openTaskId = useCrux((s) => s.openTaskId)
  const openTask = useCrux((s) => s.openTask)
  const [createOpen, setCreateOpen] = useState(false)
  const [showTriage, setShowTriage] = useState(false)
  if (!snapshot) return null
  const tasks = applyTaskFilter(spaceTasks(snapshot, currentSpaceId), snapshot, filter)
    .filter((t) => showTriage || !isTriagePending(snapshot, t))
  const doneCount = tasks.filter((t) => statusOf(snapshot, t.statusId)?.category === 'done').length
  const activeCount = tasks.filter((t) => {
    const category = statusOf(snapshot, t.statusId)?.category
    return category === 'in_progress' || category === 'in_review'
  }).length
  return <div className="relative flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="任务" description={`共 ${tasks.length} 条任务${showTriage ? '（含待分拣）' : ''}`} actions={<div className="flex items-center gap-2"><label className="flex items-center gap-2 text-my-xs text-my-tertiary"><input type="checkbox" checked={showTriage} onChange={(e) => setShowTriage(e.target.checked)} />显示待分拣</label><Button variant="primary" size="sm" disabled={!currentSpaceId || Boolean(snapshot.spaces.find((space) => space.id === currentSpaceId)?.archived)} onClick={() => setCreateOpen(true)}><Plus size={14} />新建任务</Button></div>} />
    <TaskFilters />
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-my-md border border-my-line">
      <div className="my-scrollbar min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
        {tasks.length === 0 ? <EmptyState title="暂无匹配任务" description="调整筛选条件，或新建一条任务" /> : <table className="w-full border-collapse text-left text-my-sm">
          <thead className="sticky top-0 z-10 bg-my-canvas"><tr className="border-b border-my-line text-my-xs text-my-tertiary">{['任务', '状态', '优先级', '处理人', '标签', '版本', '更新'].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.id} className={`border-b border-my-line ${openTaskId === task.id ? 'bg-my-layer-1-active' : 'hover:bg-my-layer-1'}`}>
            <td className="min-w-48 px-3 py-2"><button type="button" onClick={() => openTask(task.id)} className="flex w-full items-center gap-2 text-left"><span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{task.id}</span><span className={statusOf(snapshot, task.statusId)?.category === 'done' ? 'text-my-tertiary line-through' : 'text-my-primary'}>{task.title}</span>{task.parentTaskId && <span className="shrink-0 text-my-2xs text-my-tertiary">子任务</span>}</button><ExecutorBadge executor={task.executor} dispatchNote={task.dispatch?.note} /></td>
            <td className="px-3 py-2"><StatusBadge status={statusOf(snapshot, task.statusId)} /></td><td className="px-3 py-2"><PriorityBadge priority={task.priority} /></td>
            <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{task.assigneeIds.map((id) => <MemberChip key={id} member={memberOf(snapshot, id)} size="sm" />)}{task.assigneeIds.length === 0 && <span className="text-my-xs text-my-tertiary">未分配</span>}</div></td>
            <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{task.labelIds.map((id) => { const label = snapshot.taskLabels.find((l) => l.id === id); return label ? <LabelChip key={id} label={label} /> : null })}</div></td>
            <td className="px-3 py-2 text-my-xs text-my-secondary">{task.iterationIds.map((id) => snapshot.iterations.find((it) => it.id === id)?.name).filter(Boolean).join('、') || '未排期'}</td>
            <td className="whitespace-nowrap px-3 py-2 text-my-xs text-my-tertiary">{task.updatedAt.slice(5, 10)}</td>
          </tr>)}</tbody>
        </table>}
      </div>
      {tasks.length > 0 && (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-my-line bg-my-layer-1 px-3 py-1.5 text-my-xs tabular-nums text-my-tertiary">
          <span>共 {tasks.length} 项</span>
          <span className="flex items-center gap-3">
            <span>进行中 {activeCount}</span>
            <span>已完成 {doneCount}</span>
          </span>
        </footer>
      )}
    </div>
    <NewTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />
  </div>
}

export type { CruxID }
