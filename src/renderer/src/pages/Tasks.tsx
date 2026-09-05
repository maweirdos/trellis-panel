import { useMemo, useState } from 'react'
import { Search, Filter, Inbox } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge } from '../components/badges'
import { taskDateLabel } from '../utils/format'
import { api } from '../api'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

const COLUMNS: Array<{ status: string; label: string; dot: string; ring: string }> = [
  { status: 'planning', label: '规划中', dot: 'bg-sky-400', ring: 'ring-sky-500/40' },
  { status: 'in_progress', label: '进行中', dot: 'bg-amber-400', ring: 'ring-amber-500/40' },
  { status: 'review', label: '评审中', dot: 'bg-violet-400', ring: 'ring-violet-500/40' },
  { status: 'completed', label: '已完成', dot: 'bg-emerald-400', ring: 'ring-emerald-500/40' }
]

export function TasksPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const [query, setQuery] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const assignees = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.record?.assignee).filter(Boolean) as string[])].sort(),
    [snapshot.tasks]
  )

  const filtered = snapshot.tasks.filter((t) => {
    const q = query.trim().toLowerCase()
    if (q) {
      const hay = `${t.dirName} ${t.record?.title ?? ''} ${t.record?.description ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (assignee && t.record?.assignee !== assignee) return false
    if (priority && t.record?.priority !== priority) return false
    return true
  })

  const moveTo = async (t: TaskInfo, status: string): Promise<void> => {
    if (t.record?.status === status) return
    await api.updateTask(t.path, { status })
  }

  return (
    <div className="flex h-full animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务标题 / 描述 / 目录…"
            className="field w-64 pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5 text-mist-400">
          <Filter size={13} />
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="field w-32">
            <option value="">全部负责人</option>
            {assignees.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="field w-24">
            <option value="">全部优先级</option>
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <span className="ml-auto text-[11px] text-mist-500">{filtered.length} 个任务 · 拖拽卡片切换状态</span>
      </div>

      {/* board */}
      <div className="grid flex-1 grid-cols-4 gap-3 overflow-x-auto p-4">
        {COLUMNS.map((col) => {
          const items = filtered.filter(
            (t) => (t.record?.status ?? '').toLowerCase() === col.status ||
              (col.status === 'completed' && t.record?.status === 'done')
          )
          return (
            <div
              key={col.status}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(col.status)
              }}
              onDragLeave={() => setDragOver((cur) => (cur === col.status ? null : cur))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const dir = e.dataTransfer.getData('text/task-dir')
                const t = snapshot.tasks.find((x) => x.dirName === dir)
                if (t) void moveTo(t, col.status)
              }}
              className={clsx(
                'flex min-w-0 flex-col rounded-xl border border-ink-700 bg-ink-850/50 transition-shadow',
                dragOver === col.status && `ring-2 ${col.ring}`
              )}
            >
              <div className="flex items-center gap-2 border-b border-ink-700/70 px-3 py-2.5">
                <span className={clsx('h-2 w-2 rounded-full', col.dot)} />
                <span className="text-xs font-semibold text-mist-100">{col.label}</span>
                <span className="ml-auto rounded bg-ink-750 px-1.5 font-mono text-[10.5px] text-mist-400">
                  {items.length}
                </span>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {items.map((t) => (
                  <div
                    key={t.dirName}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
                    onClick={() => showTask(t.dirName)}
                    className="group cursor-pointer rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 transition-all hover:border-ink-500 hover:shadow-md active:cursor-grabbing"
                  >
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <PriorityBadge priority={t.record?.priority ?? ''} />
                      <span className="font-mono text-[10px] text-mist-500">
                        {taskDateLabel(t.dirName, t.date)}
                      </span>
                      {t.parseError && <span className="ml-auto text-[10px] text-rose-400">JSON 错误</span>}
                    </div>
                    <div className="line-clamp-2 text-xs leading-5 text-mist-100">
                      {t.record?.title ?? t.dirName}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-mist-500">
                      <span className="truncate">{t.record?.assignee || t.record?.creator || '未分配'}</span>
                      {t.record?.branch && (
                        <span className="truncate rounded bg-ink-750 px-1 font-mono text-[9.5px] text-mist-400">
                          ⎇ {t.record.branch}
                        </span>
                      )}
                      {t.record?.pr_url && (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.stopPropagation()
                            void api.openExternal(t.record!.pr_url!)
                          }}
                          className="ml-auto shrink-0 text-leaf-soft/80 hover:text-leaf-soft"
                        >
                          PR ↗
                        </a>
                      )}
                    </div>
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="grid place-items-center gap-1.5 py-8 text-mist-600">
                    <Inbox size={18} />
                    <span className="text-[11px]">拖拽任务到这里</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
