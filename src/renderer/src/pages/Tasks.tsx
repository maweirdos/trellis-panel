import { useMemo, useState } from 'react'
import {
  Search,
  Filter,
  Inbox,
  LayoutGrid,
  Rows3,
  Users2,
  Star,
  Paperclip,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Layers
} from 'lucide-react'
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

const statusOf = (t: TaskInfo): string => (t.record?.status ?? '').toLowerCase()

const matchCol = (t: TaskInfo, status: string): boolean =>
  statusOf(t) === status || (status === 'completed' && statusOf(t) === 'done')

/** resolve a parent/child textual reference (dirName | id | name) to an actual task */
function matchTaskByRef(ref: string | null | undefined, tasks: TaskInfo[]): TaskInfo | undefined {
  if (!ref) return undefined
  const r = ref.toLowerCase()
  return tasks.find(
    (t) =>
      t.dirName.toLowerCase() === r ||
      (t.record?.id ?? '').toLowerCase() === r ||
      (t.record?.name ?? '').toLowerCase() === r
  )
}

/* ---------------- Kanban card ---------------- */

function TaskCard({ t, onOpen }: { t: TaskInfo; onOpen: () => void }): JSX.Element {
  const current = useApp((s) => s.snapshot?.meta.currentTask)
  const isCurrent = current === t.dirName
  const prog = subtaskProgress(t)
  const jira = jiraKeyOf(t)
  const fullTitle = t.record?.title ?? t.dirName
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-dir', t.dirName)}
      onClick={onOpen}
      title={`${fullTitle}${t.record?.assignee ? ` · ${t.record.assignee}` : ''}`}
      className="group cursor-pointer rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 transition-all hover:border-ink-500 hover:shadow-md active:cursor-grabbing"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <PriorityBadge priority={t.record?.priority ?? ''} />
        <span className="font-mono text-[10px] text-mist-500">{taskDateLabel(t.dirName, t.date)}</span>
        {isCurrent && <Star size={11} className="text-leaf" fill="currentColor" />}
        {t.parseError && <span className="ml-auto text-[10px] text-rose-400">JSON 错误</span>}
      </div>
      <div className="line-clamp-2 text-xs leading-5 text-mist-100">{fullTitle}</div>
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-mist-500">
        <span className="truncate" title={t.record?.assignee || t.record?.creator || '未分配'}>
          {t.record?.assignee || t.record?.creator || '未分配'}
        </span>
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

/* ---------------- Epic card（需求 → 子任务折叠组） ---------------- */

function EpicCard({
  epic,
  children,
  onOpen
}: {
  epic: TaskInfo
  children: TaskInfo[]
  onOpen: (dir: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const done = children.filter((c) => matchCol(c, 'completed')).length
  const prog = subtaskProgress(epic)
  const fullTitle = epic.record?.title ?? epic.dirName
  return (
    <div
      className={clsx(
        'overflow-hidden rounded-lg border transition-all',
        open ? 'border-leaf-dim/40 bg-ink-800' : 'border-ink-700 bg-ink-800/80 hover:border-ink-500'
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="w-full px-3 py-2.5 text-left" title={fullTitle}>
        <div className="flex items-center gap-1.5">
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-leaf" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-mist-500" />
          )}
          <Layers size={11} className="shrink-0 text-leaf" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-leaf-soft/80">需求组</span>
          <span className="ml-auto shrink-0 rounded bg-ink-750 px-1.5 font-mono text-[10px] text-mist-400">
            {done}/{children.length}
          </span>
        </div>
        <div className="mt-1.5 line-clamp-2 pl-4 text-xs leading-5 text-mist-100">{fullTitle}</div>
        <div className="mt-1.5 flex items-center gap-2 pl-4 text-[10.5px] text-mist-500">
          <span className="truncate">{epic.record?.assignee || epic.record?.creator || '未分配'}</span>
          {prog && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <CircleCheck size={10} className={prog.done === prog.total ? 'text-leaf' : 'text-mist-600'} />
              {prog.done}/{prog.total}
            </span>
          )}
        </div>
        <div className="ml-4 mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-leaf-dim/80 transition-all"
            style={{ width: `${children.length ? (done / children.length) * 100 : 0}%` }}
          />
        </div>
      </button>
      {open && (
        <div className="space-y-1 border-t border-ink-700/70 bg-ink-850/60 p-2">
          {children.map((c) => {
            const st = statusOf(c)
            const col = COLUMNS.find((x) => matchCol(c, x.status))
            return (
              <button
                key={c.dirName}
                onClick={() => onOpen(c.dirName)}
                className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-750/60"
                title={c.record?.title ?? c.dirName}
              >
                <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', col?.dot ?? 'bg-mist-600')} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-mist-200">{c.record?.title ?? c.dirName}</span>
                <span className="shrink-0 text-[10px] text-mist-500">{c.record?.assignee || col?.label || statusLabel(st)}</span>
              </button>
            )
          })}
        </div>
      )}
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
      <span className="min-w-0 truncate text-mist-100" title={t.record?.title ?? t.dirName}>
        {t.record?.title ?? t.dirName}
      </span>
      <span className="truncate text-mist-400" title={t.record?.assignee || '未分配'}>
        {t.record?.assignee || '未分配'}
      </span>
      <StatusBadge status={t.record?.status ?? ''} />
      <span className="truncate text-right font-mono text-[10px] text-mist-500" title={t.record?.branch ?? ''}>
        {t.record?.branch ?? '—'}
      </span>
    </div>
  )
}

/* ---------------- Page ---------------- */

export function TasksPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
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

  /* ----- 任务树（parent 引用 → Epic 折叠组） ----- */
  const { childMap, childDirs, hasEpics } = useMemo(() => {
    const map = new Map<string, TaskInfo[]>()
    const dirs = new Set<string>()
    for (const t of snapshot.tasks) {
      const p = matchTaskByRef(t.record?.parent ?? null, snapshot.tasks)
      if (p && p.dirName !== t.dirName) {
        const list = map.get(p.dirName) ?? []
        list.push(t)
        map.set(p.dirName, list)
        dirs.add(t.dirName)
      }
    }
    return { childMap: map, childDirs: dirs, hasEpics: map.size > 0 }
  }, [snapshot.tasks])
  const [grouped, setGrouped] = useState<boolean | null>(null)
  const groupOn = grouped ?? hasEpics

  /* ----- 动态兜底列：自定义状态不丢失 ----- */
  const extraColumns = useMemo(() => {
    const known = new Set(COLUMNS.map((c) => c.status))
    const extras: Array<{ status: string; label: string; dot: string; ring: string }> = []
    for (const t of snapshot.tasks) {
      const st = statusOf(t)
      if (!st || st === 'done' || known.has(st)) continue
      if (!extras.some((c) => c.status === st)) {
        extras.push({ status: st, label: statusLabel(st), dot: 'bg-mist-500', ring: 'ring-mist-500/40' })
      }
    }
    return extras
  }, [snapshot.tasks])
  const columns = [...COLUMNS, ...extraColumns]

  const moveTo = async (t: TaskInfo, status: string): Promise<void> => {
    if (t.record?.status === status) return
    const res = await api.updateTask(t.path, { status })
    if (!res.ok) {
      pushToast({ kind: 'error', title: '状态更新失败', body: res.error })
    }
  }

  /* ----- 聚合状态计数（filtered） ----- */
  const counts = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        count: filtered.filter((t) => matchCol(t, c.status)).length
      })),
    [filtered, columns]
  )

  const boardColumns = groupOn ? filtered.filter((t) => !childDirs.has(t.dirName)) : filtered

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

        {/* 聚合健康度：状态计数条 */}
        <div className="hidden items-center gap-1.5 xl:flex">
          {counts.map((c) => (
            <span key={c.status} className="flex items-center gap-1 text-[11px] text-mist-400" title={c.label}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', c.dot)} />
              <span className="font-mono text-mist-200">{c.count}</span>
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setIntakeOpen(true)} className="btn-primary" title="发起需求：创建任务并交给 AI">
            <Sparkles size={12} /> 发起需求
          </button>
          {hasEpics && view === 'board' && (
            <button
              onClick={() => setGrouped(!groupOn)}
              className={clsx('chip border transition-colors', groupOn ? 'border-leaf-dim/50 text-leaf-soft' : 'border-ink-500 text-mist-400')}
              title="按需求组（parent 引用）折叠子任务"
            >
              <Layers size={11} /> 需求组{groupOn ? ' 开' : ' 关'}
            </button>
          )}
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
            {columns.map((col) => {
              const items = boardColumns.filter((t) => matchCol(t, col.status))
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
                    {items.map((t) =>
                      groupOn && childMap.has(t.dirName) ? (
                        <EpicCard
                          key={t.dirName}
                          epic={t}
                          children={childMap.get(t.dirName)!}
                          onOpen={(dir) => showTask(dir)}
                        />
                      ) : (
                        <TaskCard key={t.dirName} t={t} onOpen={() => showTask(t.dirName)} />
                      )
                    )}
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
      {view === 'swimlane' && <SwimlaneView />}
    </div>
  )
  function SwimlaneView(): JSX.Element {
    const lanes: Array<{ key: string; label: string; mine: TaskInfo[] }> = [
      ...(filtered.some((t) => !t.record?.assignee)
        ? [{ key: '__unassigned', label: '未分配', mine: filtered.filter((t) => !t.record?.assignee) }]
        : []),
      ...assignees.map((a) => ({ key: a, label: a, mine: filtered.filter((t) => t.record?.assignee === a) }))
    ]
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {lanes.length === 0 && (
          <div className="py-16 text-center text-xs text-mist-500">暂无负责人数据</div>
        )}
        <div className="space-y-4">
          {lanes.map((lane) => {
            const done = lane.mine.filter((t) => matchCol(t, 'completed')).length
            return (
              <div key={lane.key} className="card overflow-hidden">
                <div className="flex items-center gap-3 border-b border-ink-700 bg-ink-750/50 px-4 py-2.5">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-leaf-deep/60 text-[11px] font-bold text-leaf">
                    {lane.label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="text-xs font-semibold text-mist-100">{lane.label}</span>
                  <span className="text-[11px] text-mist-500">{lane.mine.length} 个任务 · 已完成 {done}</span>
                  <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className="h-full rounded-full bg-leaf-dim/80"
                      style={{ width: `${lane.mine.length ? (done / lane.mine.length) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-4 divide-x divide-ink-700/50">
                  {columns.map((col) => {
                    const items = lane.mine.filter((t) => matchCol(t, col.status))
                    const laneKey = `${lane.key}:${col.status}`
                    return (
                      <div
                        key={col.status}
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDragOver(laneKey)
                        }}
                        onDragLeave={() => setDragOver((cur) => (cur === laneKey ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault()
                          setDragOver(null)
                          const dir = e.dataTransfer.getData('text/task-dir')
                          const t = snapshot.tasks.find((x) => x.dirName === dir)
                          if (t) void moveTo(t, col.status)
                        }}
                        className={clsx(
                          'flex min-h-16 flex-col p-2',
                          dragOver === laneKey && 'bg-leaf-dim/5 ring-1 ring-inset ring-leaf-dim/40'
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-1.5 px-1">
                          <span className={clsx('h-1.5 w-1.5 rounded-full', col.dot)} />
                          <span className="text-[10.5px] text-mist-400">
                            {col.label} · {items.length}
                          </span>
                        </div>
                        <div className="max-h-56 min-h-0 space-y-1.5 overflow-y-auto">
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
    )
  }
}

