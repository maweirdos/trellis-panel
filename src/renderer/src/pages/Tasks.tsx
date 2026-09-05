import { useMemo, useState } from 'react'
import { Search, Filter, Inbox, LayoutGrid, Rows3, Users2, Star, Paperclip, CircleCheck } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import { PriorityBadge, StatusBadge, JiraChip } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { taskDateLabel } from '../utils/format'
import { api } from '../api'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

type ViewMode = 'board' | 'list' | 'swimlane'

const COLUMNS: Array<{ status: string; label: string; dot: string; ring: string }> = [
  { status: 'planning', label: '规划中', dot: 'bg-sky-400', ring: 'ring-sky-500/40' },
  { status: 'in_progress', label: '进行中', dot: 'bg-amber-400', ring: 'ring-amber-500/40' },
  { status: 'review', label: '评审中', dot: 'bg-violet-400', ring: 'ring-violet-500/40' },
  { status: 'completed', label: '已完成', dot: 'bg-emerald-400', ring: 'ring-emerald-500/40' }
]

function jiraKeyOf(t: TaskInfo): string | null {
  const k = t.record?.meta?.jiraKey
  return typeof k === 'string' && k ? k : null
}

function subtaskProgress(t: TaskInfo): { done: number; total: number } | null {
  const list = t.record?.subtasks ?? []
  if (list.length === 0) return null
  const done = list.filter((s) => /\[[xX]\]/.test(s.trim().replace(/^-\s*/, ''))).length
  return { done, total: list.length }
}

/* ---------------- Kanban card ---------------- */

function TaskCard({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const current = useApp((s) => s.snapshot?.meta.currentTask)
  const isCurrent = current === t.dirName
  const prog = subtaskProgress(t)
  const jira = jiraKeyOf(t)
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
      onClick={onOpen}
      className="group cursor-pointer rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 transition-all hover:border-ink-500 hover:shadow-md active:cursor-grabbing"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <PriorityBadge priority={t.record?.priority ?? ''} />
        <span className="font-mono text-[10px] text-mist-500">{taskDateLabel(t.dirName, t.date)}</span>
        {isCurrent && <Star size={11} className="text-leaf" fill="currentColor" />}
        {t.parseError && <span className="ml-auto text-[10px] text-rose-400">JSON 错误</span>}
      </div>
      <div className="line-clamp-2 text-xs leading-5 text-mist-100">{t.record?.title ?? t.dirName}</div>
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-mist-500">
        <span className="truncate">{t.record?.assignee || t.record?.creator || '未分配'}</span>
        {jira && <JiraChip jiraKey={jira} />}
        {prog && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <CircleCheck size={10} className={prog.done === prog.total ? 'text-leaf' : 'text-mist-600'} />
            {prog.done}/{prog.total}
          </span>
        )}
        {t.artifacts.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <Paperclip size={10} />
            {t.artifacts.length}
          </span>
        )}
        {t.record?.pr_url && (
          <a
            href="#"
            onClick={(e) => {
              e.stopPropagation()
              void api.openExternal(t.record!.pr_url!)
            }}
            className="shrink-0 text-leaf-soft/80 hover:text-leaf-soft"
          >
            PR ↗
          </a>
        )}
      </div>
    </div>
  )
}

/* ---------------- List row ---------------- */

function TaskRow({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const jira = jiraKeyOf(t)
  return (
    <div
      onClick={onOpen}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
      className="grid cursor-pointer grid-cols-[92px_84px_74px_1fr_110px_88px_84px] items-center gap-3 border-b border-ink-700/50 px-4 py-2 text-xs transition-colors hover:bg-ink-750/60"
    >
      <span className="font-mono text-[10.5px] text-mist-500">{taskDateLabel(t.dirName, t.date)}</span>
      <span>{jira ? <JiraChip jiraKey={jira} /> : <span className="text-mist-600">—</span>}</span>
      <PriorityBadge priority={t.record?.priority ?? ''} />
      <span className="min-w-0 truncate text-mist-100">{t.record?.title ?? t.dirName}</span>
      <span className="truncate text-mist-400">{t.record?.assignee || '未分配'}</span>
      <StatusBadge status={t.record?.status ?? ''} />
      <span className="truncate text-right font-mono text-[10px] text-mist-500">
        {t.record?.branch ?? '—'}
      </span>
    </div>
  )
}

/* ---------------- Page ---------------- */

export function TasksPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const [view, setView] = useState<ViewMode>('board')
  const [query, setQuery] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const assignees = useMemo(
    () => [...new Set(snapshot.tasks.map((t) => t.record?.assignee).filter(Boolean) as string[])].sort(),
    [snapshot.tasks]
  )

  const filtered = useMemo(
    () =>
      snapshot.tasks.filter((t) => {
        const q = query.trim().toLowerCase()
        if (q) {
          const hay = `${t.dirName} ${t.record?.title ?? ''} ${t.record?.description ?? ''}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        if (assignee && t.record?.assignee !== assignee) return false
        if (priority && t.record?.priority !== priority) return false
        return true
      }),
    [snapshot.tasks, query, assignee, priority]
  )

  const moveTo = async (t: TaskInfo, status: string): Promise<void> => {
    if (t.record?.status === status) return
    await api.updateTask(t.path, { status })
  }

  const matchCol = (t: TaskInfo, status: string): boolean =>
    (t.record?.status ?? '').toLowerCase() === status ||
    (status === 'completed' && t.record?.status === 'done')

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务标题 / 描述 / 目录…"
            className="field w-64 pl-8"
          />
        </div>
        <Filter size={13} className="text-mist-500" />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="field w-32">
          <option value="">全部负责人</option>
          {assignees.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="field w-28">
          <option value="">全部优先级</option>
          {['P0', 'P1', 'P2', 'P3'].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-mist-500 md:inline">{filtered.length} 个任务 · 拖拽切换状态</span>
          <div className="flex overflow-hidden rounded-lg border border-ink-500">
            {(
              [
                ['board', '看板', <LayoutGrid size={12} key="b" />],
                ['list', '列表', <Rows3 size={12} key="l" />],
                ['swimlane', '泳道', <Users2 size={12} key="s" />]
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={clsx(
                  'flex items-center gap-1 px-2.5 py-1 text-[11px] transition-colors',
                  view === id ? 'bg-leaf-dim/25 text-leaf-soft' : 'text-mist-400 hover:text-mist-200'
                )}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* board view */}
      {view === 'board' && (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-3">
          <div className="grid h-full min-h-0 auto-cols-fr grid-flow-col">
            {COLUMNS.map((col) => {
              const items = filtered.filter((t) => matchCol(t, col.status))
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
                    'mx-1.5 flex min-w-[220px] flex-col rounded-xl border border-ink-700 bg-ink-850/50 first:ml-0 last:mr-0',
                    dragOver === col.status && `ring-2 ${col.ring}`
                  )}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b border-ink-700/70 px-3 py-2.5">
                    <span className={clsx('h-2 w-2 rounded-full', col.dot)} />
                    <span className="text-xs font-semibold text-mist-100">{col.label}</span>
                    <span className="ml-auto rounded bg-ink-750 px-1.5 font-mono text-[10.5px] text-mist-400">
                      {items.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                    {items.map((t) => (
                      <TaskCard key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
                    ))}
                    {items.length === 0 && (
                      <div className="grid place-items-center gap-1.5 py-10 text-mist-600">
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
      )}

      {/* list view */}
      {view === 'list' && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="min-w-[820px]">
            <div className="sticky top-0 z-10 grid grid-cols-[92px_84px_74px_1fr_110px_88px_84px] gap-3 border-b border-ink-700 bg-ink-850 px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-mist-400">
              <span>日期</span><span>Jira</span><span>优先级</span><span>标题</span><span>负责人</span><span>状态</span><span className="text-right">分支</span>
            </div>
            {filtered.map((t) => (
              <TaskRow key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
            ))}
            {filtered.length === 0 && (
              <div className="py-16 text-center text-xs text-mist-500">没有匹配的任务</div>
            )}
          </div>
        </div>
      )}

      {/* swimlane view */}
      {view === 'swimlane' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {assignees.length === 0 && (
            <div className="py-16 text-center text-xs text-mist-500">暂无负责人数据</div>
          )}
          <div className="space-y-4">
            {assignees.map((a) => {
              const mine = filtered.filter((t) => t.record?.assignee === a)
              const done = mine.filter((t) => matchCol(t, 'completed')).length
              return (
                <div key={a} className="card overflow-hidden">
                  <div className="flex items-center gap-3 border-b border-ink-700 bg-ink-750/50 px-4 py-2.5">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-leaf-deep/60 text-[11px] font-bold text-leaf">
                      {a.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="text-xs font-semibold text-mist-100">{a}</span>
                    <span className="text-[11px] text-mist-500">{mine.length} 个任务 · 已完成 {done}</span>
                    <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className="h-full rounded-full bg-leaf-dim/80"
                        style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 divide-x divide-ink-700/50">
                    {COLUMNS.map((col) => {
                      const items = mine.filter((t) => matchCol(t, col.status))
                      return (
                        <div
                          key={col.status}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault()
                            const dir = e.dataTransfer.getData('text/task-dir')
                            const t = snapshot.tasks.find((x) => x.dirName === dir)
                            if (t) void moveTo(t, col.status)
                          }}
                          className="min-h-16 p-2"
                        >
                          <div className="mb-1.5 flex items-center gap-1.5 px-1">
                            <span className={clsx('h-1.5 w-1.5 rounded-full', col.dot)} />
                            <span className="text-[10.5px] text-mist-400">
                              {col.label} · {items.length}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {items.map((t) => (
                              <TaskCard key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
