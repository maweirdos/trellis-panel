import { useEffect, useMemo, useState } from 'react'
import {
  Users2,
  GitCommitHorizontal,
  NotebookPen,
  Bot,
  Share2,
  Star,
  Gauge,
  FileText,
  Copy,
  Save,
  CircleCheck
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { StatusBadge, PriorityBadge } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { fmtIso, relTime, taskDateLabel } from '../utils/format'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { AnalyticsResult, TaskInfo } from '../../../shared/types'

/**
 * 团队协作 —— 参考 Linear 团队页 / GitHub News Feed 的信息结构：
 * 左侧「谁在做什么」成员负载卡，右侧按日分组的动态时间线；
 * 效率分析与周报收进次级 Tab。
 */

interface FeedItem {
  at: number
  who: string
  what: string
  kind: 'task' | 'journal' | 'session'
  taskDir?: string
}

interface MemberStat {
  name: string
  total: number
  byStatus: Record<string, number>
  lastActive: number
}

type Tab = 'board' | 'efficiency' | 'report'

const AVATAR_STYLES = [
  'bg-emerald-500/20 text-emerald-300',
  'bg-sky-500/20 text-sky-300',
  'bg-violet-500/20 text-violet-300',
  'bg-amber-500/20 text-amber-300',
  'bg-rose-500/20 text-rose-300',
  'bg-cyan-500/20 text-cyan-300'
]

function avatarStyle(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_STYLES[h % AVATAR_STYLES.length]
}

function Avatar({ name, size = 7 }: { name: string; size?: number }): JSX.Element {
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-full font-bold',
        avatarStyle(name),
        size === 7 ? 'h-7 w-7 text-[11px]' : 'h-5 w-5 text-[10px]'
      )}
      title={name}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function dayLabel(ts: number): string {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= todayStart) return '今天'
  if (ts >= todayStart - 86400000) return '昨天'
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayOrder(label: string): number {
  if (label === '今天') return 0
  if (label === '昨天') return 1
  return 2
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, review: 1, planning: 2 }
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/* ---------------- 工作台：成员负载 + 动态时间线 ---------------- */

function BoardTab({ feed, members, snapshot }: {
  feed: FeedItem[]
  members: MemberStat[]
  snapshot: NonNullable<ReturnType<typeof useApp.getState>['snapshot']>
}): JSX.Element {
  const showTask = useApp((s) => s.showTask)

  const feedGroups = useMemo(() => {
    const groups = new Map<string, FeedItem[]>()
    for (const it of feed) {
      const label = dayLabel(it.at)
      const list = groups.get(label) ?? []
      list.push(it)
      groups.set(label, list)
    }
    return [...groups.entries()].sort((a, b) => dayOrder(a[0]) - dayOrder(b[0]))
  }, [feed])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      {/* 成员负载：谁在做什么（人多时自动铺成两列网格） */}
      <div className="lg:col-span-3">
        <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-mist-200">
          <Users2 size={13} className="text-mist-400" /> 成员负载
          <span className="text-[10.5px] font-normal text-mist-500">点击任务直达详情</span>
        </div>
        <div className={clsx('grid gap-3', members.length > 2 ? 'md:grid-cols-2' : 'grid-cols-1')}>
          {members.map((m) => {
            const mine = snapshot.tasks
              .filter((t) => (t.record?.assignee || t.record?.creator) === m.name)
              .sort(
                (a, b) =>
                  (STATUS_ORDER[t2s(a)] ?? 3) - (STATUS_ORDER[t2s(b)] ?? 3) ||
                  (PRIORITY_ORDER[a.record?.priority ?? ''] ?? 9) -
                    (PRIORITY_ORDER[b.record?.priority ?? ''] ?? 9) ||
                  b.updatedAt - a.updatedAt
              )
            const inflight = mine.filter((t) => !['completed', 'done'].includes((t.record?.status ?? '').toLowerCase()))
            const doneCount = m.byStatus['已完成'] ?? 0
            return (
              <div key={m.name} className="card px-4 py-3.5">
                <div className="mb-2.5 flex items-center gap-2.5">
                  <Avatar name={m.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-mist-100">{m.name}</span>
                      <span className="text-[10.5px] text-mist-500">
                        {inflight.length} 个进行中 · 完成 {doneCount}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-mist-600">
                      {m.lastActive ? `最近活跃 ${relTime(m.lastActive)}` : '暂无活跃记录'}
                    </div>
                  </div>
                  <div className="flex h-1.5 w-20 gap-px overflow-hidden rounded-full bg-ink-750">
                    {(['规划中', '进行中', '评审中', '已完成'] as const).map((label, i) => {
                      const v = m.byStatus[label] ?? 0
                      if (!v) return null
                      const colors = ['bg-sky-500/70', 'bg-amber-500/70', 'bg-violet-500/70', 'bg-emerald-500/70']
                      return (
                        <div key={label} className={clsx(colors[i], 'h-full')} style={{ width: `${(v / m.total) * 100}%` }} title={`${label} ${v}`} />
                      )
                    })}
                  </div>
                </div>
                {/* 全量列出，超出高度滚动——不再截断 */}
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {inflight.map((t) => (
                    <button
                      key={t.dirName}
                      onClick={() => showTask(t.dirName)}
                      className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-750/50"
                    >
                      <PriorityBadge priority={t.record?.priority ?? ''} />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-200">
                        {t.record?.title ?? taskDateLabel(t.dirName, t.date)}
                      </span>
                      <StatusBadge status={t.record?.status ?? ''} />
                    </button>
                  ))}
                  {inflight.length === 0 && (
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-mist-600">
                      <CircleCheck size={11} className="text-emerald-400" /> 当前没有进行中的任务
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {members.length === 0 && (
          <div className="card py-10 text-center text-[11px] text-mist-500">暂无成员数据</div>
        )}
      </div>

      {/* 动态时间线：按日分组 */}
      <div className="lg:col-span-2">
        <div className="card">
          <div className="flex items-center gap-1.5 border-b border-ink-700 px-4 py-2.5 text-xs font-semibold text-mist-200">
            <GitCommitHorizontal size={13} className="text-mist-400" /> 团队动态
          </div>
          <div className="max-h-[640px] overflow-y-auto px-4 py-3">
            {feedGroups.map(([label, items]) => (
              <div key={label} className="mb-3 last:mb-0">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist-600">{label}</div>
                <div className="space-y-2.5 border-l border-ink-700 pl-3.5">
                  {items.map((it, i) => (
                    <div key={i} className="relative flex items-start gap-2.5 text-xs">
                      <span className="absolute -left-[21px] top-0.5">{feedDot(it.kind)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-mist-300">{it.who}</span>{' '}
                        {it.kind === 'task' && it.taskDir ? (
                          <button
                            onClick={() => {
                              const t = snapshot.tasks.find((x) => x.dirName === it.taskDir)
                              if (t) showTask(t.dirName)
                              else showTask(it.taskDir!, true)
                            }}
                            className="text-left text-mist-400 hover:text-leaf-soft"
                          >
                            {it.what}
                          </button>
                        ) : (
                          <span className="text-mist-400">{it.what}</span>
                        )}
                        <span className="ml-1.5 text-[10px] text-mist-600">{relTime(it.at)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {feed.length === 0 && <div className="py-10 text-center text-[11px] text-mist-500">暂无动态</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function t2s(t: TaskInfo): string {
  return (t.record?.status ?? '').toLowerCase()
}

function feedDot(kind: FeedItem['kind']): JSX.Element {
  return (
    <span
      className={clsx(
        'grid h-[18px] w-[18px] place-items-center rounded-full ring-2 ring-ink-850',
        kind === 'task' && 'bg-amber-500/20 text-amber-300',
        kind === 'journal' && 'bg-emerald-500/20 text-emerald-300',
        kind === 'session' && 'bg-violet-500/20 text-violet-300'
      )}
    >
      {kind === 'task' && <GitCommitHorizontal size={11} />}
      {kind === 'journal' && <NotebookPen size={11} />}
      {kind === 'session' && <Bot size={11} />}
    </span>
  )
}

/* ---------------- 效率 ---------------- */

function EfficiencyTab(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const [data, setData] = useState<AnalyticsResult | null>(null)
  const maxDaily = Math.max(1, ...(data?.daily.map((d) => d.count) ?? [1]))

  useEffect(() => {
    api.getAnalytics().then(setData)
  }, [snapshot?.scannedAt])

  if (!data) return <div className="p-8 text-xs text-mist-500">分析中…</div>

  return (
    <div className="space-y-4 lg:col-span-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="card px-4 py-3">
          <div className="text-[11px] text-mist-400">记录到的状态流转</div>
          <div className="mt-1 text-xl font-semibold text-mist-50">{data.totalTransitions}</div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[11px] text-mist-400">平均交付周期（创建→完成）</div>
          <div className="mt-1 text-xl font-semibold text-mist-50">
            {data.avgCycleDays !== null ? `${data.avgCycleDays} 天` : '—'}
          </div>
        </div>
        <div className="card px-4 py-3">
          <div className="text-[11px] text-mist-400">停滞任务（&gt;3 天无动静）</div>
          <div className={clsx('mt-1 text-xl font-semibold', data.aging.length > 0 ? 'text-amber-300' : 'text-mist-50')}>
            {data.aging.length}
          </div>
        </div>
      </div>

      <div className="card px-4 py-3.5">
        <div className="mb-3 text-xs font-semibold text-mist-200">近 14 天流转热度</div>
        <div className="flex h-24 items-end gap-1.5">
          {data.daily.map((d) => (
            <div key={d.date} className="group relative flex-1">
              <div
                className="w-full rounded-t bg-leaf-dim/70 transition-colors group-hover:bg-leaf"
                style={{ height: `${(d.count / maxDaily) * 96}px`, minHeight: d.count ? '4px' : '2px' }}
                title={`${d.date}: ${d.count} 次`}
              />
              <div className="mt-1 truncate text-center text-[9px] text-mist-600">{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="card px-4 py-3.5">
          <div className="mb-2.5 text-xs font-semibold text-mist-200">成员平均交付周期</div>
          {data.memberCycle.length === 0 && <div className="text-[11px] text-mist-500">暂无已完成任务数据</div>}
          <div className="space-y-1.5">
            {data.memberCycle.map((m) => (
              <div key={m.name} className="flex items-center gap-2 text-[11px]">
                <Avatar name={m.name} size={5} />
                <span className="text-mist-200">{m.name}</span>
                <span className="ml-auto font-mono text-mist-400">
                  {m.avgDays !== null ? `${m.avgDays} 天 / ${m.completed} 任务` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card px-4 py-3.5">
          <div className="mb-2.5 text-xs font-semibold text-mist-200">停滞任务预警</div>
          {data.aging.length === 0 && <div className="text-[11px] text-emerald-300">没有停滞任务 👍</div>}
          <div className="space-y-1.5">
            {data.aging.map((t) => (
              <div key={t.dirName} className="flex items-center gap-2 text-[11px]">
                <span className="chip border border-amber-500/30 bg-amber-500/10 text-amber-300">{t.days} 天</span>
                <span className="min-w-0 flex-1 truncate text-mist-300">{t.title}</span>
                <span className="shrink-0 text-mist-500">{t.assignee}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {data.recent.length > 0 && (
        <div className="card px-4 py-3.5">
          <div className="mb-2 text-xs font-semibold text-mist-200">最近流转</div>
          <div className="space-y-1">
            {data.recent.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] text-mist-400">
                <span className="font-mono">{fmtIso(new Date(e.ts).toISOString())}</span>
                <span className="text-mist-300">{e.title}</span>
                <span className="text-mist-600">
                  {e.from ? `${statusLabel(e.from)} → ${statusLabel(e.to)}` : `→ ${statusLabel(e.to)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- 周报 ---------------- */

function ReportTab(): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [scope, setScope] = useState<'personal' | 'team'>('team')
  const [markdown, setMarkdown] = useState('')
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)

  const gen = async (sc: 'personal' | 'team'): Promise<void> => {
    setLoading(true)
    const res = await api.generateReport(sc)
    setLoading(false)
    setMarkdown(res.markdown)
    setFileName(res.suggestedFileName)
  }

  return (
    <div className="space-y-3 lg:col-span-5">
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-ink-500">
          {(
            [
              ['team', '团队周报'],
              ['personal', '个人周报']
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => {
                setScope(v)
                void gen(v)
              }}
              className={clsx(
                'px-3 py-1.5 text-[11px] transition-colors',
                scope === v ? 'bg-leaf-dim/25 text-leaf-soft' : 'text-mist-400 hover:text-mist-200'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => void gen(scope)} disabled={loading} className="btn-primary disabled:opacity-50">
          <Gauge size={12} /> {loading ? '生成中…' : '生成周报'}
        </button>
        {markdown && (
          <>
            <button
              onClick={async () => {
                await api.copyToClipboard(markdown)
                pushToast({ kind: 'success', title: '周报已复制到剪贴板' })
              }}
              className="btn-outline"
            >
              <Copy size={12} /> 复制
            </button>
            <button
              onClick={async () => {
                const res = await api.saveReport(fileName, markdown)
                if (res.ok) pushToast({ kind: 'success', title: '周报已保存', body: res.path })
                else pushToast({ kind: 'error', title: '保存失败', body: res.error })
              }}
              className="btn-outline"
            >
              <Save size={12} /> 保存到工作区
            </button>
          </>
        )}
      </div>
      {markdown ? (
        <pre className="max-h-[60vh] select-text overflow-auto rounded-xl border border-ink-700 bg-ink-950/70 p-4 font-mono text-[11.5px] leading-5 text-mist-300">
          {markdown}
        </pre>
      ) : (
        <div className="card grid place-items-center gap-2 py-16 text-mist-500">
          <FileText size={20} />
          <span className="text-xs">点击「生成周报」— 面板会汇总本周任务流转、完成情况、成员工作量与 Jira 对账</span>
        </div>
      )}
    </div>
  )
}

/* ---------------- page ---------------- */

export function TeamPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const [tab, setTab] = useState<Tab>('board')

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = []
    for (const t of [...snapshot.tasks, ...snapshot.archived]) {
      if (!t.updatedAt) continue
      items.push({
        at: t.updatedAt,
        who: t.record?.assignee || t.record?.creator || '未知',
        what: `更新了任务「${t.record?.title ?? t.dirName}」`,
        kind: 'task',
        taskDir: t.archived ? t.path : t.dirName
      })
    }
    for (const d of snapshot.developers) {
      for (const j of [...d.journals, ...d.otherFiles]) {
        items.push({ at: j.mtime, who: d.name, what: `写入工作区日志 ${j.name}`, kind: 'journal' })
      }
    }
    for (const s of snapshot.sessions.slice(0, 12)) {
      items.push({
        at: s.lastSeen ? new Date(s.lastSeen).getTime() : 0,
        who: s.platform,
        what: `AI 会话活跃${s.currentTask ? `（${s.currentTask}）` : ''}`,
        kind: 'session'
      })
    }
    return items.sort((a, b) => b.at - a.at).slice(0, 80)
  }, [snapshot])

  const members = useMemo<MemberStat[]>(() => {
    const map = new Map<string, MemberStat>()
    for (const t of snapshot.tasks) {
      const who = t.record?.assignee || t.record?.creator || '未分配'
      const m = map.get(who) ?? { name: who, total: 0, byStatus: {}, lastActive: 0 }
      m.total += 1
      const st = statusLabel(t.record?.status)
      m.byStatus[st] = (m.byStatus[st] ?? 0) + 1
      m.lastActive = Math.max(m.lastActive, t.updatedAt)
      map.set(who, m)
    }
    for (const d of snapshot.developers) {
      const m = map.get(d.name) ?? { name: d.name, total: 0, byStatus: {}, lastActive: 0 }
      m.lastActive = Math.max(m.lastActive, d.lastActive)
      map.set(d.name, m)
    }
    return [...map.values()].sort((a, b) => b.total - a.total || b.lastActive - a.lastActive)
  }, [snapshot])

  const currentTask = snapshot.tasks.find((t) => t.dirName === snapshot.meta.currentTask)
  const inflightCount = snapshot.tasks.filter((t) => !['completed', 'done'].includes((t.record?.status ?? '').toLowerCase())).length
  const doneThisWeek = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000
    return [...snapshot.tasks, ...snapshot.archived].filter(
      (t) => t.record?.completedAt && new Date(`${t.record.completedAt}T00:00:00`).getTime() >= weekAgo
    ).length
  }, [snapshot])

  const shareTask = async (t: TaskInfo): Promise<void> => {
    const r = t.record
    if (!r) return
    const md = [
      `## ${r.title}`,
      `- 状态：${statusLabel(r.status)} ｜ 优先级：${r.priority} ｜ 负责人：${r.assignee || '—'}`,
      `- 目录：\`${t.dirName}\` ｜ 分支：\`${r.branch ?? '—'}\` ｜ 创建：${r.createdAt || '—'}`,
      r.description ? `\n${r.description}` : '',
      r.notes ? `\n> ${r.notes.replace(/\n/g, '\n> ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    await api.copyToClipboard(md)
    pushToast({ kind: 'success', title: '分享文本已复制', body: '可直接粘贴到 IM / Jira 评论' })
  }

  return (
    <div className="h-full animate-fade-in overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Users2 size={16} className="text-mist-400" />
          <h1 className="text-base font-semibold text-mist-50">团队协作</h1>
          <div className="flex items-center gap-1.5">
            {[
              ['成员', members.length],
              ['进行中', inflightCount],
              ['本周完成', doneThisWeek],
              ['AI 会话', snapshot.sessions.length]
            ].map(([label, v]) => (
              <span key={label as string} className="chip bg-ink-800 text-[10.5px] text-mist-400">
                {label} <span className="ml-0.5 font-mono text-mist-200">{v}</span>
              </span>
            ))}
          </div>
          <div className="ml-auto flex overflow-hidden rounded-lg border border-ink-500">
            {(
              [
                ['board', '工作台'],
                ['efficiency', '效率分析'],
                ['report', '周报']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={clsx(
                  'px-3 py-1.5 text-[11px] transition-colors',
                  tab === id ? 'bg-leaf-dim/25 text-leaf-soft' : 'text-mist-400 hover:text-mist-200'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {currentTask?.record && tab === 'board' && (
          <div className="card flex items-center gap-4 px-5 py-3.5">
            <Star size={15} className="shrink-0 text-leaf" fill="currentColor" />
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] uppercase tracking-wider text-mist-500">全队当前焦点</div>
              <button onClick={() => showTask(currentTask.dirName)} className="truncate text-xs font-medium text-mist-100 hover:text-leaf-soft">
                {currentTask.record.title}
              </button>
            </div>
            <StatusBadge status={currentTask.record.status} />
            <button onClick={() => void shareTask(currentTask)} className="btn-outline shrink-0">
              <Share2 size={12} /> 分享
            </button>
          </div>
        )}

        {tab === 'board' && <BoardTab feed={feed} members={members} snapshot={snapshot} />}
        {tab === 'efficiency' && <EfficiencyTab />}
        {tab === 'report' && <ReportTab />}
      </div>
    </div>
  )
}
