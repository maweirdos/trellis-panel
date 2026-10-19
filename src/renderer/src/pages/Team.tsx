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
  CircleCheck,
  Loader2,
  Sparkles
} from 'lucide-react'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { api, hasIpc } from '../api'
import { Button, EmptyState, Tabs } from '../my/ui'
import { StatusBadge, PriorityBadge } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { fmtIso, relTime, taskDateLabel } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { AnalyticsResult, ProjectSnapshot, TaskInfo } from '../../../shared/types'

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
  archived?: boolean
}

interface MemberStat {
  name: string
  total: number
  byStatus: Record<string, number>
  lastRecordAt: number
}

const AVATAR_STYLES = [
  'bg-my-label-emerald text-my-label-emerald-text',
  'bg-my-label-indigo text-my-label-indigo-text',
  'bg-my-label-purple text-my-label-purple-text',
  'bg-my-label-yellow text-my-label-yellow-text',
  'bg-my-label-crimson text-my-label-crimson-text',
  'bg-my-label-orange text-my-label-orange-text'
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
        size === 7 ? 'h-7 w-7 text-my-xs' : 'h-5 w-5 text-my-2xs'
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

/* ---------------- 协作投影：成员负载 + 动态时间线 ---------------- */

function BoardTab({ feed, members, snapshot, mode = 'overview' }: {
  mode?: 'overview' | 'members' | 'activity'
  feed: FeedItem[]
  members: MemberStat[]
  snapshot: NonNullable<ReturnType<typeof useApp.getState>['snapshot']>
}): JSX.Element {
  const showTask = useApp((s) => s.showTask)
  const [responsibility, setResponsibility] = useState<'all' | 'mine' | 'unassigned'>('all')
  const filteredMembers = members.filter((member) => responsibility === 'all' || (responsibility === 'unassigned' ? member.name === '未分配' : member.name === snapshot.meta.developer))
  const visibleMembers = mode === 'overview' ? filteredMembers.slice(0, 4) : filteredMembers
  const unassignedCount = snapshot.tasks.filter((task) => !task.record?.assignee && !isFinished(task)).length

  const feedGroups = useMemo(() => {
    const groups = new Map<string, FeedItem[]>()
    for (const it of (mode === 'overview' ? feed.slice(0, 6) : feed)) {
      const label = dayLabel(it.at)
      const list = groups.get(label) ?? []
      list.push(it)
      groups.set(label, list)
    }
    return [...groups.entries()].sort((a, b) => dayOrder(a[0]) - dayOrder(b[0]))
  }, [feed, mode])

  return (
    <div className={clsx("grid grid-cols-1 gap-5", mode === 'overview' && "xl:grid-cols-5")}>
      {/* 成员负载：谁在做什么（人多时自动铺成两列网格） */}
      {mode !== 'activity' && <div className={mode === 'overview' ? 'xl:col-span-3' : ''}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-my-xs font-semibold text-my-primary">
          <Users2 size={13} className="text-my-icon-secondary" /> 成员负载
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="按任务负责人筛选">
            {([
              ['all', '全部'],
              ['mine', '我负责'],
              ['unassigned', `未分配 ${unassignedCount}`]
            ] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={responsibility === value} onClick={() => setResponsibility(value)} className={clsx('my-control my-control-sm border', responsibility === value ? 'border-my-line-accent-subtle bg-my-accent-subtle text-my-accent-text' : 'border-transparent text-my-secondary hover:bg-my-layer-1-hover')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          {visibleMembers.map((m) => {
            const mine = snapshot.tasks
              .filter((t) => (t.record?.assignee || '未分配') === m.name)
              .sort(
                (a, b) =>
                  (STATUS_ORDER[t2s(a)] ?? 3) - (STATUS_ORDER[t2s(b)] ?? 3) ||
                  (PRIORITY_ORDER[a.record?.priority ?? ''] ?? 9) -
                    (PRIORITY_ORDER[b.record?.priority ?? ''] ?? 9) ||
                  b.updatedAt - a.updatedAt
              )
            const inflight = mine.filter((t) => !isFinished(t))
            const doneCount = m.byStatus['已完成'] ?? 0
            return (
              <div key={m.name} className="rounded-my-lg border border-my-line bg-my-surface-1 px-4 py-3.5">
                <div className="mb-2.5 flex items-center gap-2.5">
                  <Avatar name={m.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-my-xs font-semibold text-my-primary">{m.name}</span>
                      <span className="text-my-xs text-my-tertiary">
                        {inflight.length} 个未结束 · 完成 {doneCount}
                      </span>
                    </div>
                    <div className="mt-0.5 text-my-xs text-my-secondary">
                      {m.lastRecordAt ? `关联文件最近更新 ${relTime(m.lastRecordAt)}` : '暂无文件更新记录'}
                    </div>
                  </div>
                  <div className="flex h-1.5 w-20 gap-px overflow-hidden rounded-full bg-my-layer-3">
                    {(['规划中', '进行中', '评审中', '已完成'] as const).map((label, i) => {
                      const v = m.byStatus[label] ?? 0
                      if (!v) return null
                      const colors = ['bg-my-info', 'bg-my-warning', 'bg-my-label-purple', 'bg-my-success']
                      return (
                        <div key={label} className={clsx(colors[i], 'h-full')} style={{ width: `${(v / m.total) * 100}%` }} title={`${label} ${v}`} />
                      )
                    })}
                  </div>
                </div>
                {mode === 'overview' && inflight.length > 3 && <p className="mb-1 text-my-xs text-my-tertiary">另有 {inflight.length - 3} 项，前往成员查看</p>}
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {(mode === 'overview' ? inflight.slice(0, 3) : inflight).map((t) => (
                    <button
                      key={t.dirName}
                      onClick={() => showTask(t.dirName)}
                      className="flex w-full items-center gap-2 rounded-my-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-my-line hover:bg-my-layer-1"
                    >
                      <PriorityBadge priority={t.record?.priority ?? ''} />
                      <span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">
                        {t.record?.title ?? taskDateLabel(t.dirName, t.date)}
                      </span>
                      <StatusBadge status={t.record?.status ?? ''} />
                    </button>
                  ))}
                  {inflight.length === 0 && (
                    <div className="flex items-center gap-1.5 px-2 py-1 text-my-xs text-my-placeholder">
                      <CircleCheck size={11} className="text-my-success-text" /> 当前没有未结束任务
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {visibleMembers.length === 0 && (
          <div className="rounded-my-lg border border-my-line bg-my-surface-1 py-10 text-center text-my-sm text-my-secondary">{responsibility === 'mine' && !snapshot.meta.developer ? '当前项目未设置开发者身份' : '此范围暂无任务负责人'}</div>
        )}
      </div>}

      {/* 动态时间线：按日分组 */}
      {mode !== 'members' && <div className={mode === 'overview' ? 'xl:col-span-2' : ''}>
        <div className="overflow-hidden rounded-my-lg border border-my-line bg-my-surface-1">
          <div className="flex items-center gap-1.5 border-b border-my-line px-4 py-2.5 text-my-xs font-semibold text-my-secondary">
            <GitCommitHorizontal size={13} className="text-my-tertiary" /> 最近记录
          </div>
          <p className="border-b border-my-line bg-my-layer-1 px-4 py-2 text-my-xs leading-5 text-my-secondary">来自任务、工作区文件和会话时间记录；负责人不等于实际操作者。</p>
          <div className="my-scrollbar max-h-[640px] overflow-y-auto px-4 py-3">
            {feedGroups.map(([label, items]) => (
              <div key={label} className="mb-4 last:mb-0">
                {/* 吸顶日期分割栏 */}
                <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center gap-2 bg-my-canvas px-4 py-1">
                  <span className="rounded-my-sm bg-my-layer-2 px-2 py-0.5 font-mono text-my-2xs font-semibold text-my-tertiary">
                    {label}
                  </span>
                  <div className="h-px flex-1 bg-my-line" />
                </div>

                {/* 时间线列表（轴线绝对居中穿过图标） */}
                <div className="relative pl-6">
                  {/* 垂直时间轴线 */}
                  <div className="absolute left-[8px] top-2 bottom-2 w-px bg-my-line" />

                  <div className="space-y-3">
                    {items.map((it, i) => (
                      <div key={i} className="relative flex items-start gap-2.5 text-my-xs">
                        {/* 时间线节点图标（居中覆盖在轴线上） */}
                        <span className="absolute -left-[23px] top-0.5 z-10 flex h-[18px] w-[18px] items-center justify-center">
                          {feedDot(it.kind)}
                        </span>

                        {/* 动态内容区（标题与时间戳分离，彻底杜绝时间戳折行撕裂） */}
                        <div className="min-w-0 flex-1 leading-snug">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="truncate font-semibold text-my-secondary">{it.who}</span>
                            <span className="shrink-0 font-mono text-my-2xs text-my-tertiary whitespace-nowrap">
                              {relTime(it.at)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-my-sm text-my-tertiary break-words">
                            {it.kind === 'task' && it.taskDir ? (
                              <button
                                onClick={() => {
                                  if (it.taskDir) showTask(it.taskDir, it.archived ?? false)
                                }}
                                className="text-left text-my-secondary hover:text-my-accent-text hover:underline transition-colors"
                              >
                                {it.what}
                              </button>
                            ) : (
                              <span>{it.what}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {feed.length === 0 && <div className="py-10 text-center text-my-xs text-my-tertiary">暂无记录</div>}
          </div>
        </div>
      </div>}
    </div>
  )
}

function t2s(t: TaskInfo): string {
  return (t.record?.status ?? '').toLowerCase()
}

function isFinished(task: TaskInfo): boolean {
  return ['completed', 'done', 'cancelled', 'canceled'].includes(t2s(task))
}

function feedDot(kind: FeedItem['kind']): JSX.Element {
  return (
    <span
      className={clsx(
        'grid h-[18px] w-[18px] place-items-center rounded-full ring-2 ring-my-canvas shadow-xs',
        kind === 'task' && 'bg-my-label-yellow text-my-label-yellow-text',
        kind === 'journal' && 'bg-my-label-emerald text-my-label-emerald-text',
        kind === 'session' && 'bg-my-label-purple text-my-label-purple-text'
      )}
    >
      {kind === 'task' && <GitCommitHorizontal size={11} />}
      {kind === 'journal' && <NotebookPen size={11} />}
      {kind === 'session' && <Bot size={11} />}
    </span>
  )
}

/* ---------------- 效率 ---------------- */

export function TeamEfficiency(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const pushToast = useApp((s) => s.pushToast)
  const aiEnabled = useApp((s) => s.settings?.ai.enabled ?? false)
  const [data, setData] = useState<AnalyticsResult | null>(null)
  const [diag, setDiag] = useState<string | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const maxDaily = Math.max(1, ...(data?.daily.map((d) => d.count) ?? [1]))

  useEffect(() => {
    if (!hasIpc) return
    api.getAnalytics().then(setData)
  }, [snapshot?.scannedAt])

  /** AI 深度诊断（R9）：把效率数据交给 AI 解读——停滞归因、负载失衡、行动建议 */
  const runDiagnosis = async (): Promise<void> => {
    if (!data || diagnosing) return
    setDiagnosing(true)
    setDiag(null)
    try {
      const tasks = snapshot?.tasks ?? []
      const byStatus = new Map<string, number>()
      for (const t of tasks) {
        const s = String(t.record?.status ?? 'unknown')
        byStatus.set(s, (byStatus.get(s) ?? 0) + 1)
      }
      const facts = [
        `项目：${snapshot?.meta.name ?? '未知'}，活跃任务 ${tasks.length} 个`,
        `状态分布：${[...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(' / ')}`,
        `记录到的状态流转：${data.totalTransitions} 次`,
        `平均交付周期：${data.avgCycleDays !== null ? `${data.avgCycleDays} 天` : '无数据'}`,
        `停滞任务（>3 天无动静）：${data.aging.length} 个${data.aging.length ? '——' + data.aging.map((t) => `「${t.title}」停 ${t.days} 天（${t.assignee}）`).join('；') : ''}`,
        `成员交付：${data.memberCycle.map((m) => `${m.name} 平均 ${m.avgDays ?? '?'} 天/${m.completed} 个`).join('；') || '无数据'}`,
        `近 14 天流转：${data.daily.map((d) => `${d.date.slice(5)}:${d.count}`).join('、')}`
      ].join('\n')
      const res = await api.aiChat([
        {
          role: 'system',
          content:
            '你是项目管理诊断师，服务不懂编程的负责人。基于给定的项目效率数据输出诊断报告（Markdown）：\n## 一句话总评\n## 风险与停滞归因（指出具体任务，推测可能原因）\n## 团队负载观察（谁可能过载/闲置）\n## 本周建议做的 3 件事（具体、可执行）\n数据不足以判断的地方直说，不要编造。全程简体中文，结论先行。'
        },
        { role: 'user', content: `项目效率数据：\n${facts}` }
      ])
      if (res.ok && res.content) setDiag(res.content)
      else pushToast({ kind: 'error', title: '诊断失败', body: res.error })
    } finally {
      setDiagnosing(false)
    }
  }

  if (!data) return <div className="p-8 text-my-xs text-my-tertiary">{hasIpc ? '分析中…' : '连接桌面项目后可读取流转记录'}</div>

  return (
    <div className="space-y-4 lg:col-span-5">
      <div className="flex items-center gap-2">
        <div className="text-my-xs font-semibold text-my-secondary">效率分析</div>
        {aiEnabled && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => void runDiagnosis()} disabled={diagnosing} title="AI 解读效率数据：停滞归因、负载观察、行动建议">
            {diagnosing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} {diagnosing ? 'AI 诊断中…' : 'AI 深度诊断'}
          </Button>
        )}
      </div>
      {diag && (
        <div className="my-card px-4 py-3.5">
          <div className="mb-2 flex items-center gap-1.5 text-my-xs font-semibold text-my-accent-text">
            <Sparkles size={12} /> AI 诊断报告
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void api.copyToClipboard(diag).then(() => pushToast({ kind: 'success', title: '已复制' }))}>
              复制
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto text-my-xs">
            <MarkdownView content={diag} />
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <div className="my-card px-4 py-3">
          <div className="text-my-xs text-my-tertiary">记录到的状态流转</div>
          <div className="mt-1 text-my-xl font-semibold text-my-primary">{data.totalTransitions}</div>
        </div>
        <div className="my-card px-4 py-3">
          <div className="text-my-xs text-my-tertiary">平均交付周期（创建→完成）</div>
          <div className="mt-1 text-my-xl font-semibold text-my-primary">
            {data.avgCycleDays !== null ? `${data.avgCycleDays} 天` : '—'}
          </div>
        </div>
        <div className="my-card px-4 py-3">
          <div className="text-my-xs text-my-tertiary">停滞任务（&gt;3 天无动静）</div>
          <div className={clsx('mt-1 text-my-xl font-semibold', data.aging.length > 0 ? 'text-my-warning-text' : 'text-my-primary')}>
            {data.aging.length}
          </div>
        </div>
      </div>

      <div className="my-card px-4 py-3.5">
        <div className="mb-3 text-my-xs font-semibold text-my-secondary">近 14 天流转热度</div>
        <div className="flex h-24 items-end gap-1.5">
          {data.daily.map((d) => (
            <div key={d.date} className="group relative flex-1">
              <div
                className="w-full rounded-t bg-my-accent transition-[filter] group-hover:brightness-110"
                style={{ height: `calc(var(--my-space-96) * ${d.count / maxDaily})`, minHeight: d.count ? 'var(--my-space-4)' : 'var(--my-space-2)' }}
                title={`${d.date}: ${d.count} 次`}
              />
              <div className="mt-1 truncate text-center text-my-2xs text-my-placeholder">{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="my-card px-4 py-3.5">
          <div className="mb-2.5 text-my-xs font-semibold text-my-secondary">成员平均交付周期</div>
          {data.memberCycle.length === 0 && <div className="text-my-xs text-my-tertiary">暂无已完成任务数据</div>}
          <div className="space-y-1.5">
            {data.memberCycle.map((m) => (
              <div key={m.name} className="flex items-center gap-2 text-my-xs">
                <Avatar name={m.name} size={5} />
                <span className="text-my-secondary">{m.name}</span>
                <span className="ml-auto font-mono text-my-tertiary">
                  {m.avgDays !== null ? `${m.avgDays} 天 / ${m.completed} 任务` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="my-card px-4 py-3.5">
          <div className="mb-2.5 text-my-xs font-semibold text-my-secondary">停滞任务预警</div>
          {data.aging.length === 0 && <div className="text-my-xs text-my-success-text">没有停滞任务 👍</div>}
          <div className="space-y-1.5">
            {data.aging.map((t) => (
              <div key={t.dirName} className="flex items-center gap-2 text-my-xs">
                <span className="my-chip border border-my-label-yellow-border bg-my-label-yellow text-my-label-yellow-text">{t.days} 天</span>
                <span className="min-w-0 flex-1 truncate text-my-secondary">{t.title}</span>
                <span className="shrink-0 text-my-tertiary">{t.assignee}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {data.recent.length > 0 && (
        <div className="my-card px-4 py-3.5">
          <div className="mb-2 text-my-xs font-semibold text-my-secondary">最近流转</div>
          <div className="space-y-1">
            {data.recent.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-my-xs text-my-tertiary">
                <span className="font-mono">{fmtIso(new Date(e.ts).toISOString())}</span>
                <span className="text-my-secondary">{e.title}</span>
                <span className="text-my-placeholder">
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
        <div className="flex overflow-hidden rounded-my-md border border-my-line">
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
                'my-control my-control-sm rounded-none',
                scope === v ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-tertiary hover:bg-my-layer-1'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={() => void gen(scope)} disabled={loading}>
          <Gauge size={12} /> {loading ? '生成中…' : '生成周报'}
        </Button>
        {markdown && (
          <>
            <Button
              variant="outline"
              onClick={async () => {
                await api.copyToClipboard(markdown)
                pushToast({ kind: 'success', title: '周报已复制到剪贴板' })
              }}
            >
              <Copy size={12} /> 复制
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const res = await api.saveReport(fileName, markdown)
                if (res.ok) pushToast({ kind: 'success', title: '周报已保存', body: res.path })
                else pushToast({ kind: 'error', title: '保存失败', body: res.error })
              }}
            >
              <Save size={12} /> 保存到工作区
            </Button>
          </>
        )}
      </div>
      {markdown ? (
        <pre className="max-h-[60vh] select-text overflow-auto rounded-my-xl border border-my-line bg-my-canvas p-4 font-mono text-my-sm leading-5 text-my-secondary">
          {markdown}
        </pre>
      ) : (
        <div className="my-card grid place-items-center gap-2 py-16 text-my-tertiary">
          <FileText size={20} />
          <span className="text-my-xs">点击「生成周报」— 面板会汇总本周任务流转、完成情况、成员工作量与 Jira 对账</span>
        </div>
      )}
    </div>
  )
}

/* ---------------- page ---------------- */

export function TeamPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  // 浏览器预览（?my=1）无 IPC 桥、snapshot 恒为 null：渲染空态而非在渲染期解引用崩溃
  // （真机 MainApp 在 snapshot 就绪后才挂载页面，此分支不出现）
  if (!snapshot) return <EmptyState title="项目未加载" />
  return <TeamPageBody snapshot={snapshot} />
}

function TeamPageBody({ snapshot }: { snapshot: ProjectSnapshot }): JSX.Element {
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const section = useMy((state) => state.teamView)
  const setSection = useMy((state) => state.setTeamView)
  const [reportType, setReportType] = useState<'daily' | 'weekly'>('daily')

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = []
    for (const t of [...snapshot.tasks, ...snapshot.archived]) {
      if (!t.updatedAt) continue
      items.push({
        at: t.updatedAt,
        who: `负责人 · ${t.record?.assignee || '未分配'}`,
        what: `任务文件更新「${t.record?.title ?? t.dirName}」`,
        kind: 'task',
        taskDir: t.archived ? t.path : t.dirName,
        archived: Boolean(t.archived)
      })
    }
    for (const d of snapshot.developers) {
      for (const j of [...d.journals, ...d.otherFiles]) {
        items.push({ at: j.mtime, who: `工作区 · ${d.name}`, what: `文件更新 ${j.name}`, kind: 'journal' })
      }
    }
    for (const s of snapshot.sessions.slice(0, 12)) {
      const at = s.lastSeen ? new Date(s.lastSeen).getTime() : 0
      if (!Number.isFinite(at) || at <= 0) continue
      items.push({
        at,
        who: `平台 · ${s.platform}`,
        what: `会话记录${s.currentTask ? `（${s.currentTask}）` : ''}`,
        kind: 'session'
      })
    }
    return items.sort((a, b) => b.at - a.at).slice(0, 80)
  }, [snapshot])

  const members = useMemo<MemberStat[]>(() => {
    const map = new Map<string, MemberStat>()
    for (const t of snapshot.tasks) {
      const who = t.record?.assignee || '未分配'
      const m = map.get(who) ?? { name: who, total: 0, byStatus: {}, lastRecordAt: 0 }
      m.total += 1
      const st = statusLabel(t.record?.status)
      m.byStatus[st] = (m.byStatus[st] ?? 0) + 1
      m.lastRecordAt = Math.max(m.lastRecordAt, t.updatedAt)
      map.set(who, m)
    }
    for (const d of snapshot.developers) {
      const m = map.get(d.name) ?? { name: d.name, total: 0, byStatus: {}, lastRecordAt: 0 }
      m.lastRecordAt = Math.max(m.lastRecordAt, d.lastActive)
      map.set(d.name, m)
    }
    return [...map.values()].sort((a, b) => b.total - a.total || b.lastRecordAt - a.lastRecordAt)
  }, [snapshot])

  const currentTask = snapshot.tasks.find((t) => t.dirName === snapshot.meta.currentTask)
  const inflightCount = snapshot.tasks.filter((t) => !isFinished(t)).length
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
    <div>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            {[
              ['已知成员', members.filter((member) => member.name !== '未分配').length],
              ['未结束', inflightCount],
              ['近 7 天完成', doneThisWeek],
              ['AI 会话', snapshot.sessions.length]
            ].map(([label, v]) => (
              <span key={label as string} className="my-chip bg-my-layer-2 text-my-tertiary">
                {label} <span className="ml-0.5 font-mono text-my-secondary">{v}</span>
              </span>
            ))}
          </div>

        </div>

        {currentTask?.record && section === 'overview' && (
          <div className="my-card flex items-center gap-4 px-5 py-3.5">
            <Star size={15} className="shrink-0 text-my-accent-text" fill="currentColor" />
            <div className="min-w-0 flex-1">
              <div className="text-my-xs uppercase tracking-wider text-my-tertiary">最近会话绑定的任务</div>
              <button onClick={() => showTask(currentTask.dirName)} className="truncate text-my-xs font-medium text-my-primary hover:text-my-accent-text">
                {currentTask.record.title}
              </button>
            </div>
            <StatusBadge status={currentTask.record.status} />
            <Button variant="outline" className="shrink-0" onClick={() => void shareTask(currentTask)}>
              <Share2 size={12} /> 分享
            </Button>
          </div>
        )}

        {section === 'overview' && <>
          <p className="text-my-sm text-my-secondary">成员来自当前项目开发者与任务负责人记录；负载按未结束任务汇总。</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSection('members')}>查看成员</Button>
            <Button variant="ghost" onClick={() => setSection('activity')}>查看动态</Button>
          </div>
          <BoardTab feed={feed} members={members} snapshot={snapshot} />
        </>}
        {section === 'members' && <BoardTab feed={feed} members={members} snapshot={snapshot} mode="members" />}
        {section === 'activity' && <BoardTab feed={feed} members={members} snapshot={snapshot} mode="activity" />}
        {section === 'reports' && <>
          <Tabs tabs={[{ id: 'daily', label: '日报' }, { id: 'weekly', label: '周报' }]} active={reportType} onChange={setReportType} />
          {reportType === 'daily' ? <StandupTab /> : <ReportTab />}
        </>}

      </div>
    </div>
  )
}

/* ---------------- 站会 Tab ---------------- */

function StandupTab(): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [markdown, setMarkdown] = useState('')
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)

  const generate = async (): Promise<void> => {
    setLoading(true)
    const res = await api.generateStandup()
    setLoading(false)
    setMarkdown(res.markdown)
    setFileName(res.suggestedFileName)
  }

  useEffect(() => {
    if (!hasIpc) return
    void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="my-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-my-xs font-semibold text-my-primary">每日站会摘要</span>
        <span className="text-my-xs text-my-tertiary">完成 · 在途 · 阻塞</span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" onClick={() => void generate()} disabled={loading}>
            重新生成
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void api.copyToClipboard(markdown)
              pushToast({ kind: 'success', title: '站会摘要已复制' })
            }}
            disabled={!markdown}
          >
            <Copy size={11} /> 复制
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (!markdown) return
              const res = await api.saveReport(fileName || 'standup.md', markdown)
              if (res.ok) pushToast({ kind: 'success', title: '已保存到 workspace', body: res.path })
              else pushToast({ kind: 'error', title: '保存失败', body: res.error })
            }}
            disabled={!markdown}
          >
            <Save size={11} /> 存入工作区
          </Button>
        </div>
      </div>
      <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-my-lg border border-my-line bg-my-canvas p-3 font-mono text-my-sm leading-5 text-my-secondary">
        {markdown || '生成中…'}
      </pre>
    </div>
  )
}

/* ---------------- 工作流洞察 Tab ---------------- */

function WorkflowInsightTab({ snapshot }: { snapshot: ProjectSnapshot }): JSX.Element {
  const [scan, setScan] = useState<import('../../../shared/types').StudioScan | null>(null)

  useEffect(() => {
    if (!hasIpc) return
    void api.studioScan().then((res) => {
      if (res.ok && res.scan) setScan(res.scan)
    })
  }, [snapshot.meta.root])

  const usage = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of snapshot.tasks) {
      const wf = typeof t.record?.workflow === 'string' && t.record.workflow ? t.record.workflow : '(默认链)'
      map.set(wf, (map.get(wf) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [snapshot.tasks])

  const aging = useMemo(
    () =>
      snapshot.tasks
        .filter((t) => ['in_progress', 'review'].includes((t.record?.status ?? '').toLowerCase()))
        .map((t) => ({ t, days: Math.floor((Date.now() - t.updatedAt) / 86400000) }))
        .filter((x) => x.days >= 3)
        .sort((a, b) => b.days - a.days)
        .slice(0, 8),
    [snapshot.tasks]
  )

  return (
    <div className="space-y-4">
      <div className="my-card p-4">
        <div className="mb-3 text-my-xs font-semibold text-my-primary">Workflow 解析链（团队 → 个人 → 任务）</div>
        {scan ? (
          <div className="grid gap-2 text-my-sm md:grid-cols-4">
            <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
              <div className="text-my-2xs uppercase tracking-wide text-my-tertiary">任务 pin</div>
              <div className="mt-1 font-mono text-my-primary">
                {scan.workflows.reduce((n, w) => n + w.pinnedTasks.length, 0) || '—'}
              </div>
            </div>
            <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
              <div className="text-my-2xs uppercase tracking-wide text-my-tertiary">个人默认（.developer）</div>
              <div className="mt-1 font-mono text-my-primary">{scan.chain.developerWorkflow ?? '—'}</div>
            </div>
            <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
              <div className="text-my-2xs uppercase tracking-wide text-my-tertiary">团队默认（config.yaml）</div>
              <div className="mt-1 font-mono text-my-primary">{scan.chain.configDefault ?? '—'}</div>
            </div>
            <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
              <div className="text-my-2xs uppercase tracking-wide text-my-tertiary">全局回退</div>
              <div className="mt-1 font-mono text-my-primary">{scan.chain.globalExists ? 'workflow.md ✓' : '缺失'}</div>
            </div>
          </div>
        ) : (
          <div className="text-my-xs text-my-tertiary">读取中…</div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="my-card p-4">
          <div className="mb-3 text-my-xs font-semibold text-my-primary">任务 workflow 分布</div>
          {usage.length === 0 ? (
            <div className="text-my-xs text-my-tertiary">暂无任务</div>
          ) : (
            <div className="space-y-2">
              {usage.map(([wf, n]) => (
                <div key={wf} className="flex items-center gap-2 text-my-sm">
                  <span className="w-32 truncate font-mono text-my-secondary" title={wf}>{wf}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-my-layer-3">
                    <div className="h-full bg-my-accent" style={{ width: `${(n / snapshot.tasks.length) * 100}%` }} />
                  </div>
                  <span className="font-mono text-my-tertiary">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="my-card p-4">
          <div className="mb-3 text-my-xs font-semibold text-my-primary">流程健康度 · 停滞任务（≥3 天无动静）</div>
          {aging.length === 0 ? (
            <div className="text-my-xs text-my-success-text">没有停滞任务 👍</div>
          ) : (
            <div className="space-y-1.5">
              {aging.map(({ t, days }) => (
                <div key={t.dirName} className="flex items-center gap-2 text-my-sm">
                  <StatusBadge status={t.record?.status ?? ''} />
                  <span className="min-w-0 flex-1 truncate text-my-secondary">{t.record?.title ?? t.dirName}</span>
                  <span className="text-my-tertiary">{t.record?.assignee || '未分配'}</span>
                  <span className={clsx('font-mono', days >= 7 ? 'text-my-danger-text' : 'text-my-warning-text')}>{days}d</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {scan && (
        <div className="my-card p-4">
          <div className="mb-3 text-my-xs font-semibold text-my-primary">平台覆盖</div>
          <div className="flex flex-wrap gap-1.5">
            {scan.platforms.filter((p) => p.detected).map((p) => (
              <span key={p.id} className="my-chip bg-my-accent-subtle text-my-accent-text">{p.name}</span>
            ))}
            {scan.platforms.filter((p) => p.detected).length === 0 && (
              <span className="text-my-sm text-my-tertiary">未检测到 AI 平台目录——运行 trellis init --&lt;platform&gt; 安装</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function TeamWorkflow(): JSX.Element {
  const snapshot = useApp((state) => state.snapshot)
  return snapshot ? <WorkflowInsightTab snapshot={snapshot} /> : <EmptyState title="项目未加载" />
}
