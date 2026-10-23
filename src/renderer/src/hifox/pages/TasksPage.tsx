/**
 * 任务列表：筛选（关键词/类型/标签/优先级/处理人/迭代）+ 新建 + 详情抽屉入口。
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { useHifox, spaceTasks, applyTaskFilter, memberOf, statusOf, isTriagePending, visibleLabels } from '../store'
import { PageHeader, StatusBadge, PriorityBadge, LabelChip, MemberChip, ExecutorBadge, Field, inputClass } from '../ui'
import { TaskDetailDrawer, NewTaskModal } from './TaskDetailDrawer'
import { Button, EmptyState, SearchInput } from '../../my/ui'
import type { HifoxID, HifoxPriority } from '@shared/hifox'

export function TasksPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const filter = useHifox((s) => s.taskFilter)
  const setTaskFilter = useHifox((s) => s.setTaskFilter)
  const openTaskId = useHifox((s) => s.openTaskId)
  const openTask = useHifox((s) => s.openTask)
  const [createOpen, setCreateOpen] = useState(false)
  /** PRD 3.5 规则1：待分拣任务默认排除，提供显示选项 */
  const [showTriage, setShowTriage] = useState(false)

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const tasks = useMemo(
    () => applyTaskFilter(spaceTasks(snapshot, currentSpaceId), snapshot, filter)
      .filter((t) => showTriage || !isTriagePending(snapshot, t)),
    [snapshot, currentSpaceId, filter, showTriage]
  )
  const types = snapshot.taskTypes.filter((t) => t.spaceId === currentSpaceId)
  const labels = visibleLabels(snapshot, currentSpaceId)
  const iterations = snapshot.iterations.filter((i) => i.spaceId === currentSpaceId)
  const members = space?.memberIds.map((id) => memberOf(snapshot, id)).filter(Boolean) ?? []

  const toggleIn = (key: 'typeIds' | 'labelIds' | 'assigneeIds' | 'priorities', id: string) => {
    const current = (filter[key] as string[] | undefined) ?? []
    setTaskFilter({ [key]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] } as Record<string, never>)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="任务"
        description={`共 ${tasks.length} 条命中筛选${showTriage ? '（含待分拣）' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-tertiary" title="PRD 3.5：待分拣任务默认排除，去分拣台处理">
              <input type="checkbox" checked={showTriage} onChange={(e) => setShowTriage(e.target.checked)} />
              显示待分拣
            </label>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建任务</Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={filter.keyword ?? ''}
          onChange={(keyword) => setTaskFilter({ keyword })}
          placeholder="搜索任务编号或标题"
        />
        <div className="flex flex-wrap items-center gap-1">
          {types.map((type) => (
            <button key={type.id} type="button" onClick={() => toggleIn('typeIds', type.id)}
              className={`rounded-my-sm px-1.5 py-0.5 text-my-xs transition-colors ${filter.typeIds?.includes(type.id) ? 'bg-indigo-500/20 text-indigo-400' : 'bg-my-layer text-my-secondary hover:bg-my-layer-active'}`}>
              {type.name}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-my-line" />
          {(['urgent', 'high', 'medium', 'low'] as HifoxPriority[]).map((p) => (
            <button key={p} type="button" onClick={() => toggleIn('priorities', p)}
              className={`rounded-my-sm px-1.5 py-0.5 text-my-xs transition-colors ${filter.priorities?.includes(p) ? 'bg-red-500/20 text-red-400' : 'bg-my-layer text-my-secondary hover:bg-my-layer-active'}`}>
              {p === 'urgent' ? '紧急' : p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-my-line" />
          {members.map((m) => m && (
            <button key={m.id} type="button" title={`筛选 ${m.name}`} onClick={() => toggleIn('assigneeIds', m.id)}
              className={`rounded-full p-0.5 transition-opacity ${filter.assigneeIds?.includes(m.id) ? 'ring-2 ring-indigo-400' : 'opacity-60 hover:opacity-100'}`}>
              <span className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-medium text-white" style={{ backgroundColor: `hsl(${m.avatarHue} 55% 45%)` }}>{m.name.slice(0, 1)}</span>
            </button>
          ))}
        </div>
        {iterations.length > 0 && (
          <select className={`${inputClass} w-auto`} value={filter.iterationId ?? ''} onChange={(e) => setTaskFilter({ iterationId: e.target.value || undefined })}>
            <option value="">全部迭代</option>
            {iterations.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
          </select>
        )}
        {labels.length > 0 && (
          <select className={`${inputClass} w-auto`} value={''} onChange={(e) => { if (e.target.value) toggleIn('labelIds', e.target.value); e.target.value = '' }}>
            <option value="">按标签筛选…</option>
            {labels.map((l) => <option key={l.id} value={l.id}>{filter.labelIds?.includes(l.id) ? `✓ ${l.name}` : l.name}</option>)}
          </select>
        )}
      </div>

      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto rounded-my-md border border-my-line">
        {tasks.length === 0 ? (
          <EmptyState title="暂无匹配任务" description="调整筛选条件，或新建一条任务" />
        ) : (
          <table className="w-full border-collapse text-left text-my-sm">
            <thead className="sticky top-0 z-10 bg-my-canvas">
              <tr className="border-b border-my-line text-my-xs text-my-tertiary">
                <th className="px-3 py-2 font-medium">任务</th>
                <th className="w-24 px-2 py-2 font-medium">状态</th>
                <th className="w-16 px-2 py-2 font-medium">优先级</th>
                <th className="w-36 px-2 py-2 font-medium">处理人</th>
                <th className="w-24 px-2 py-2 font-medium">标签</th>
                <th className="w-20 px-2 py-2 font-medium">迭代</th>
                <th className="w-24 px-3 py-2 font-medium">更新</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const open = openTaskId === task.id
                return (
                  <tr
                    key={task.id}
                    onClick={() => openTask(task.id)}
                    className={`cursor-pointer border-b border-my-line/60 transition-colors ${open ? 'bg-my-layer-active' : 'hover:bg-my-layer-transparent-hover'}`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 font-mono text-[10px] text-my-tertiary">{task.id}</span>
                        <span className={`min-w-0 flex-1 truncate ${statusOf(snapshot, task.statusId)?.category === 'done' ? 'text-my-tertiary line-through' : 'text-my-primary'}`}>{task.title}</span>
                        {task.parentTaskId && <span className="shrink-0 rounded-my-sm bg-my-layer px-1 text-[10px] text-my-tertiary" title={`子任务 of ${task.parentTaskId}`}>子</span>}
                        <ExecutorBadge executor={task.executor} dispatchNote={task.dispatch?.note} />
                      </div>
                    </td>
                    <td className="px-2 py-2"><StatusBadge status={statusOf(snapshot, task.statusId)} /></td>
                    <td className="px-2 py-2"><PriorityBadge priority={task.priority} /></td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        {task.assigneeIds.slice(0, 3).map((id) => <MemberChip key={id} member={memberOf(snapshot, id)} size="sm" />)}
                        {task.assigneeIds.length > 3 && <span className="text-my-xs text-my-tertiary">+{task.assigneeIds.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {task.labelIds.map((id) => {
                          const label = snapshot.taskLabels.find((l) => l.id === id)
                          return label ? <LabelChip key={id} label={label} /> : null
                        })}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-my-xs text-my-secondary">
                      {task.iterationIds.length > 0
                        ? snapshot.iterations.find((it) => it.id === task.iterationIds[0])?.name ?? '—'
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-my-xs text-my-tertiary">{task.updatedAt.slice(5, 10)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <NewTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <TaskDetailDrawer />
    </div>
  )
}

export type { HifoxID }
