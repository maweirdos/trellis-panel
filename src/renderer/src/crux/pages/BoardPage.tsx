import { useState } from 'react'
import { BookmarkPlus, Plus, X } from 'lucide-react'
import { api } from '../../api'
import { useCrux, spaceTasks, applyTaskFilter, memberOf, statusOf, isTriagePending, allowedStatusIdsFor, PRIORITY_LABEL } from '../store'
import { PageHeader, StatusBadge, PriorityBadge, ExecutorBadge, MemberChip, inputClass, compactInputClass, Select } from '../ui'
import { Button, EmptyState } from '../../my/ui'
import { TaskFilters } from './TasksPage'
import { NewTaskModal } from './TaskDetailDrawer'
import { TaskOutputReviewBoardBadge } from '../task-output-review/task-output-review'
import type { CruxTask, CruxView, CruxPriority } from '@shared/crux'

type GroupBy = CruxView['groupBy']
const GROUP_LABEL: Record<GroupBy, string> = { status: '按状态', assignee: '按处理人', type: '按类型', priority: '按优先级' }

export function BoardPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const filter = useCrux((s) => s.taskFilter)
  const activeViewId = useCrux((s) => s.activeViewId)
  const applyView = useCrux((s) => s.applySavedView)
  const setFilter = useCrux((s) => s.setTaskFilter)
  const openTask = useCrux((s) => s.openTask)
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const [localGroup, setGroupBy] = useState<GroupBy>('status')
  const [viewName, setViewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [showTriage, setShowTriage] = useState(false)
  if (!snapshot) return null
  const readOnly = Boolean(snapshot.spaces.find((space) => space.id === spaceId)?.archived)
  const groupBy = snapshot.views.find((v) => v.id === activeViewId)?.groupBy ?? localGroup
  const tasks = applyTaskFilter(spaceTasks(snapshot, spaceId), snapshot, filter).filter((t) => showTriage || !isTriagePending(snapshot, t))
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === spaceId).sort((a, b) => a.order - b.order)
  const types = snapshot.taskTypes.filter((t) => t.spaceId === spaceId)
  const savedViews = snapshot.views.filter((v) => v.spaceId === spaceId)
  let columns: Array<{ key: string; title: string; tasks: CruxTask[] }>
  if (groupBy === 'status') columns = statuses.map((s) => ({ key: s.id, title: s.name, tasks: tasks.filter((t) => t.statusId === s.id) }))
  else if (groupBy === 'assignee') {
    const ids = new Set([...(snapshot.spaces.find((s) => s.id === spaceId)?.memberIds ?? []), ...tasks.flatMap((t) => t.assigneeIds)])
    columns = [...ids].map((id) => ({ key: id, title: memberOf(snapshot, id)?.name ?? '已离开的成员', tasks: tasks.filter((t) => t.assigneeIds.includes(id)) }))
    columns.push({ key: 'none', title: '未分配', tasks: tasks.filter((t) => t.assigneeIds.length === 0) })
  } else if (groupBy === 'type') {
    columns = types.map((t) => ({ key: t.id, title: t.name, tasks: tasks.filter((task) => task.typeId === t.id) }))
    columns.push({ key: 'none', title: '未设置类型', tasks: tasks.filter((t) => !t.typeId || !types.some((type) => type.id === t.typeId)) })
  } else columns = (Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((p) => ({ key: p, title: PRIORITY_LABEL[p], tasks: tasks.filter((t) => t.priority === p) }))
  const moveTask = (taskId: string, statusId: string): void => {
    const task = tasks.find((t) => t.id === taskId)
    if (!busy && !readOnly && task && task.statusId !== statusId && allowedStatusIdsFor(snapshot, task.spaceId, task.typeId).has(statusId)) void run('移动任务', () => api.crux.updateTask({ id: task.id, patch: { statusId } }))
  }
  const saveView = async (): Promise<void> => {
    if (!spaceId || !viewName.trim() || busy) return
    const result = await run('保存视图', () => api.crux.saveView({ spaceId, name: viewName.trim(), filter, groupBy }))
    if (result?.ok) { setViewName(''); setSaving(false) }
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="看板" description={`共 ${tasks.length} 条任务${groupBy === 'assignee' ? '；多人任务分别出现在每位处理人列，总数按任务去重' : '；按状态分组时可拖动卡片流转'}`} actions={<div className="flex flex-wrap items-center gap-2">
      <Select
        size="sm"
        ariaLabel="看板分组"
        value={groupBy}
        onChange={(val) => { setGroupBy(val as GroupBy); applyView(null) }}
        options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({ value: g, label: GROUP_LABEL[g] }))}
      />
      <Button size="sm" disabled={readOnly} onClick={() => setSaving(!saving)}><BookmarkPlus size={14} />保存视图</Button><Button size="sm" variant="primary" disabled={!spaceId || readOnly} onClick={() => setCreateOpen(true)}><Plus size={14} />新建任务</Button>
    </div>} />
    <TaskFilters />
    <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-my-xs text-my-tertiary"><input type="checkbox" checked={showTriage} onChange={(e) => setShowTriage(e.target.checked)} />显示待分拣</label>
      {savedViews.map((view) => <span key={view.id} className={`flex items-center gap-1 rounded-my-md border px-2 py-1 text-my-xs ${view.id === activeViewId ? 'border-my-line-strong bg-my-layer-1-active text-my-primary' : 'border-my-line text-my-secondary'}`}><button type="button" aria-pressed={view.id === activeViewId} onClick={() => { setGroupBy(view.groupBy); applyView(view.id) }}>{view.name}</button><button type="button" disabled={busy || readOnly} aria-label={`删除视图 ${view.name}`} onClick={() => void run('删除视图', () => api.crux.removeView({ id: view.id })).then((r) => { if (r?.ok && activeViewId === view.id) applyView(null) })}><X size={14} /></button></span>)}
    </div>
    {saving && <div className="flex items-center gap-2"><input aria-label="视图名称" autoFocus className={`${inputClass} max-w-64`} placeholder="视图名称" value={viewName} onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveView() }} /><Button size="sm" variant="primary" disabled={!viewName.trim() || busy} onClick={() => void saveView()}>保存筛选和分组</Button><Button size="sm" onClick={() => setSaving(false)}>取消</Button></div>}
    <div className="my-scrollbar min-h-0 flex-1 overflow-x-auto">
      {columns.length === 0 ? <EmptyState title="暂无分组" description="先在空间配置中添加任务状态" /> : <div className="flex h-full min-h-0 gap-3 pb-1">{columns.map((column) => <section key={column.key} data-column={column.key} aria-label={`${column.title}，${column.tasks.length} 条任务`} className="flex min-h-0 w-64 shrink-0 flex-col rounded-my-md border border-my-line bg-my-layer-1" onDragOver={(e) => { if (groupBy === 'status' && !busy) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); if (groupBy === 'status') moveTask(e.dataTransfer.getData('application/x-crux-task'), column.key) }}>
        <header className="flex items-center gap-2 border-b border-my-line px-3 py-2"><h2 className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{column.title}</h2><span className="text-my-xs text-my-tertiary">{column.tasks.length}</span></header>
        <div className="my-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2" style={{ scrollbarGutter: 'stable' }}>{column.tasks.map((task) => {
          const allowed = allowedStatusIdsFor(snapshot, task.spaceId, task.typeId)
          const blocking = task.relations.filter((r) => r.kind === 'blocks')
          const resolved = blocking.filter((r) => { const related = snapshot.tasks.find((t) => t.id === r.taskId); return related && ['done', 'cancelled'].includes(statusOf(snapshot, related.statusId)?.category ?? '') }).length
          return <article key={task.id} draggable={groupBy === 'status' && !busy && !readOnly} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-crux-task', task.id) }} className="rounded-my-md border border-my-line bg-my-canvas p-2">
            <button type="button" onClick={() => openTask(task.id)} className="mb-2 w-full text-left text-my-xs leading-relaxed text-my-primary"><span className="mr-1 font-mono text-my-2xs text-my-tertiary">{task.id}</span><span className={statusOf(snapshot, task.statusId)?.category === 'done' ? 'text-my-tertiary line-through' : ''}>{task.title}</span></button>
            <div className="flex flex-wrap items-center gap-1">{groupBy !== 'status' && <StatusBadge status={statusOf(snapshot, task.statusId)} />}{task.priority !== 'none' && <PriorityBadge priority={task.priority} />}<ExecutorBadge executor={task.executor} dispatchNote={task.dispatch?.note} /></div>
            <div className="mt-2 flex flex-wrap items-center gap-1">{task.assigneeIds.map((id) => <MemberChip key={id} member={memberOf(snapshot, id)} size="sm" />)}<TaskOutputReviewBoardBadge task={task} />{blocking.length > 0 && <span className="ml-auto text-my-2xs text-my-tertiary">阻塞 {blocking.length} · 已结束 {resolved}/{blocking.length}</span>}</div>
            <Select
              size="sm"
              ariaLabel={`更改 ${task.id} 状态`}
              className="mt-2 w-full"
              disabled={busy || readOnly}
              value={task.statusId}
              onChange={(val) => moveTask(task.id, val)}
              options={statuses.filter((s) => allowed.has(s.id)).map((s) => ({ value: s.id, label: s.name }))}
            />
          </article>
        })}{column.tasks.length === 0 && <p className="py-3 text-center text-my-xs text-my-tertiary">暂无任务</p>}</div>
      </section>)}</div>}
    </div>
    <NewTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />
  </div>
}
