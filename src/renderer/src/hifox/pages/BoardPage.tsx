/**
 * 看板视图：按状态/处理人/类型/优先级分组 + 保存视图的创建与应用（PRD 3.5）。
 */
import { useMemo, useState } from 'react'
import { BookmarkPlus, X } from 'lucide-react'
import { api } from '../../api'
import { useHifox, spaceTasks, applyTaskFilter, memberOf, statusOf } from '../store'
import { PageHeader, StatusBadge, PriorityBadge, ExecutorBadge, inputClass } from '../ui'
import { Button, EmptyState } from '../../my/ui'
import type { HifoxTask, HifoxView } from '@shared/hifox'

type GroupBy = HifoxView['groupBy']

const GROUP_LABEL: Record<GroupBy, string> = { status: '按状态', assignee: '按处理人', type: '按类型', priority: '按优先级' }

export function BoardPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const filter = useHifox((s) => s.taskFilter)
  const activeViewId = useHifox((s) => s.activeViewId)
  const applySavedView = useHifox((s) => s.applySavedView)
  const setTaskFilter = useHifox((s) => s.setTaskFilter)
  const openTask = useHifox((s) => s.openTask)
  const run = useHifox((s) => s.run)
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [viewName, setViewName] = useState('')
  const [saving, setSaving] = useState(false)

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const tasks = useMemo(() => applyTaskFilter(spaceTasks(snapshot, currentSpaceId), snapshot, filter), [snapshot, currentSpaceId, filter])
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === currentSpaceId).sort((a, b) => a.order - b.order)
  const types = snapshot.taskTypes.filter((t) => t.spaceId === currentSpaceId)
  const members = space?.memberIds.map((id) => memberOf(snapshot, id)).filter(Boolean) ?? []
  const savedViews = snapshot.views.filter((v) => v.spaceId === currentSpaceId)

  const columns: Array<{ key: string; title: string; accent?: string; tasks: HifoxTask[] }> = useMemo(() => {
    if (groupBy === 'status') {
      return statuses.map((s) => ({ key: s.id, title: s.name, tasks: tasks.filter((t) => t.statusId === s.id) }))
    }
    if (groupBy === 'assignee') {
      const cols = members.map((m) => m && { key: m.id, title: m.name, tasks: tasks.filter((t) => t.assigneeIds.includes(m.id)) })
      cols.push({ key: 'none', title: '未分配', tasks: tasks.filter((t) => t.assigneeIds.length === 0) })
      return cols.filter((c): c is { key: string; title: string; tasks: HifoxTask[] } => Boolean(c))
    }
    if (groupBy === 'type') {
      const cols = types.map((t) => ({ key: t.id, title: t.name, tasks: tasks.filter((x) => x.typeId === t.id) }))
      cols.push({ key: 'none', title: '未设置类型', tasks: tasks.filter((t) => !t.typeId) })
      return cols
    }
    return (['urgent', 'high', 'medium', 'low', 'none'] as const).map((p) => ({
      key: p, title: { urgent: '紧急', high: '高', medium: '中', low: '低', none: '无优先级' }[p], tasks: tasks.filter((t) => t.priority === p)
    }))
  }, [groupBy, tasks, statuses, members, types])

  const saveView = async (): Promise<void> => {
    if (!currentSpaceId || !viewName.trim()) return
    const result = await run('保存视图', () => api.hifox.saveView({ spaceId: currentSpaceId, name: viewName.trim(), filter, groupBy }))
    if (result?.ok) { setViewName(''); setSaving(false) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="看板"
        description="按分组维度摊开任务；筛选可保存为视图"
        actions={
          <div className="flex items-center gap-2">
            <select className={`${inputClass} w-auto`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </select>
            {!saving
              ? <Button variant="outline" size="sm" onClick={() => setSaving(true)}><BookmarkPlus size={13} />保存当前为视图</Button>
              : (
                <div className="flex items-center gap-1">
                  <input autoFocus className={`${inputClass} w-32`} placeholder="视图名称" value={viewName} onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveView() }} />
                  <Button variant="primary" size="sm" disabled={!viewName.trim()} onClick={() => void saveView()}>保存</Button>
                  <Button variant="ghost" size="sm" onClick={() => setSaving(false)}><X size={13} /></Button>
                </div>
              )}
          </div>
        }
      />

      {savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-my-xs text-my-tertiary">视图：</span>
          <button type="button" onClick={() => { applySavedView(null); setTaskFilter({}) }}
            className={`rounded-my-sm px-2 py-0.5 text-my-xs ${activeViewId === null ? 'bg-indigo-500/20 text-indigo-300' : 'bg-my-layer text-my-secondary hover:bg-my-layer-active'}`}>
            临时筛选
          </button>
          {savedViews.map((view) => (
            <span key={view.id} className={`group/view flex items-center gap-1 rounded-my-sm px-2 py-0.5 text-my-xs ${activeViewId === view.id ? 'bg-indigo-500/20 text-indigo-300' : 'bg-my-layer text-my-secondary hover:bg-my-layer-active'}`}>
              <button type="button" onClick={() => { applySavedView(view.id); setGroupBy(view.groupBy) }}>{view.name}</button>
              <button type="button" aria-label={`删除视图 ${view.name}`} className="opacity-0 transition-opacity group-hover/view:opacity-100" onClick={() => void run('删除视图', () => api.hifox.removeView({ id: view.id }))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="my-scrollbar min-h-0 flex-1 overflow-x-auto">
        {columns.length === 0
          ? <EmptyState title="暂无分组维度" description="先在空间配置中补充类型或状态" />
          : (
            <div className="flex h-full min-h-0 gap-3 pb-1">
              {columns.map((column) => (
                <section key={column.key} className="flex min-h-0 w-64 shrink-0 flex-col rounded-my-md border border-my-line bg-my-layer/60">
                  <header className="flex items-center gap-2 border-b border-my-line px-2.5 py-2">
                    <h2 className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{column.title}</h2>
                    <span className="rounded-full bg-my-layer-active px-1.5 text-[10px] text-my-tertiary">{column.tasks.length}</span>
                  </header>
                  <div className="my-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                    {column.tasks.map((task) => (
                      <button key={task.id} type="button" onClick={() => openTask(task.id)}
                        className="w-full rounded-my-md border border-my-line bg-my-canvas p-2 text-left transition-colors hover:border-my-brand/50">
                        <p className={`mb-1.5 line-clamp-2 text-my-xs leading-relaxed ${statusOf(snapshot, task.statusId)?.category === 'done' ? 'text-my-tertiary line-through' : 'text-my-primary'}`}>
                          <span className="mr-1 font-mono text-[10px] text-my-tertiary">{task.id}</span>{task.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-1">
                          {groupBy !== 'status' && <StatusBadge status={statusOf(snapshot, task.statusId)} />}
                          {groupBy !== 'priority' && task.priority !== 'none' && <PriorityBadge priority={task.priority} />}
                          <ExecutorBadge executor={task.executor} dispatchNote={task.dispatch?.note} />
                        </div>
                        {task.assigneeIds.length > 0 && (
                          <div className="mt-1.5 flex gap-1">
                            {task.assigneeIds.slice(0, 4).map((id) => {
                              const member = memberOf(snapshot, id)
                              return member
                                ? <span key={id} title={member.name} className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-medium text-white" style={{ backgroundColor: `hsl(${member.avatarHue} 55% 45%)` }}>{member.name.slice(0, 1)}</span>
                                : null
                            })}
                          </div>
                        )}
                      </button>
                    ))}
                    {column.tasks.length === 0 && <p className="px-1 py-3 text-center text-[11px] text-my-tertiary">空</p>}
                  </div>
                </section>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}
