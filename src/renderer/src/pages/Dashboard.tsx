import {
  Activity,
  Bot,
  CheckCircle2,
  ClipboardList,
  FileCode2,
  GitBranch,
  Layers,
  Rocket,
  Timer
} from 'lucide-react'
import { useApp } from '../store'
import { PriorityBadge, StatusBadge } from '../components/badges'
import { fmtIso, relTime } from '../utils/format'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

function Stat({
  label,
  value,
  accent,
  icon
}: {
  label: string
  value: number | string
  accent: string
  icon: JSX.Element
}): JSX.Element {
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <div className={`grid h-9 w-9 place-items-center rounded-lg ${accent}`}>{icon}</div>
      <div>
        <div className="text-lg font-semibold leading-6 text-mist-50">{value}</div>
        <div className="text-[11px] text-mist-400">{label}</div>
      </div>
    </div>
  )
}

export function Dashboard(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const setPage = useApp((s) => s.setPage)
  const showTask = useApp((s) => s.showTask)

  const { meta, tasks, sessions, developers } = snapshot
  const byStatus = (st: string): TaskInfo[] => tasks.filter((t) => t.record?.status === st)
  const planning = byStatus('planning')
  const inProgress = byStatus('in_progress')
  const review = byStatus('review')
  const completed = tasks.filter((t) => ['completed', 'done'].includes(t.record?.status ?? ''))
  const doneRate = tasks.length ? Math.round((completed.length / tasks.length) * 100) : 0

  const current = tasks.find((t) => t.dirName === meta.currentTask)
  const recent = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const activePlatforms = meta.platforms.filter((p) => p.detected)
  const lastActive = developers.reduce((acc, d) => Math.max(acc, d.lastActive), 0)

  return (
    <div className="mx-auto max-w-6xl animate-fade-in space-y-5 p-6">
      {/* header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-mist-50">
            {meta.name}
            <span className="ml-2 align-middle text-xs font-normal text-mist-400">
              Trellis {meta.version ?? '未初始化版本'}
            </span>
          </h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-mist-500" title={meta.root}>
            {meta.root}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-mist-400">
          <Timer size={12} />
          扫描于 {fmtIso(new Date(snapshot.scannedAt).toISOString())}
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="全部任务" value={tasks.length} accent="bg-ink-750 text-mist-200" icon={<ClipboardList size={16} />} />
        <Stat label="规划中" value={planning.length} accent="bg-sky-500/15 text-sky-300" icon={<Layers size={16} />} />
        <Stat label="进行中" value={inProgress.length} accent="bg-amber-500/15 text-amber-300" icon={<Rocket size={16} />} />
        <Stat label="评审中" value={review.length} accent="bg-violet-500/15 text-violet-300" icon={<Activity size={16} />} />
        <Stat label="已完成" value={`${completed.length} · ${doneRate}%`} accent="bg-emerald-500/15 text-emerald-300" icon={<CheckCircle2 size={16} />} />
      </div>

      {/* current task */}
      {current?.record && (
        <button
          onClick={() => showTask(current.dirName)}
          className="card group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:border-leaf-dim/40"
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-leaf-deep/50 text-leaf">
            <GitBranch size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="chip bg-leaf/10 text-leaf-soft">当前任务</span>
              <StatusBadge status={current.record.status} />
              <PriorityBadge priority={current.record.priority} />
            </div>
            <div className="truncate text-[13px] font-medium text-mist-100">{current.record.title}</div>
            <div className="truncate font-mono text-[11px] text-mist-500">{current.dirName}</div>
          </div>
        </button>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* recent tasks */}
        <div className="card lg:col-span-3">
          <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
            <span className="text-xs font-semibold text-mist-200">最近更新任务</span>
            <button onClick={() => setPage('tasks')} className="text-[11px] text-leaf-soft/90 hover:text-leaf-soft">
              查看看板 →
            </button>
          </div>
          <div className="divide-y divide-ink-700/60">
            {recent.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-mist-500">还没有任务</div>
            )}
            {recent.map((t) => (
              <button
                key={t.dirName}
                onClick={() => showTask(t.dirName)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-ink-750/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-mist-100">
                    {t.record?.title ?? t.dirName}
                    {t.parseError && <span className="ml-1.5 text-[10px] text-rose-400">(解析失败)</span>}
                  </div>
                  <div className="truncate font-mono text-[10.5px] text-mist-500">
                    {t.dirName} · {t.record?.assignee || t.record?.creator || '—'}
                  </div>
                </div>
                <span className="shrink-0 text-[10.5px] text-mist-500">{relTime(t.updatedAt)}</span>
                {t.record && <StatusBadge status={t.record.status} />}
              </button>
            ))}
          </div>
        </div>

        {/* side info */}
        <div className="space-y-4 lg:col-span-2">
          <div className="card px-4 py-3.5">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
              <Bot size={13} className="text-mist-400" /> AI 平台 ({activePlatforms.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {activePlatforms.length === 0 && <span className="text-[11px] text-mist-500">未检测到已初始化的平台</span>}
              {activePlatforms.map((p) => (
                <span key={p.id} className="chip border border-leaf-dim/25 bg-leaf/10 text-leaf-soft">
                  {p.name}
                </span>
              ))}
            </div>
          </div>

          <div className="card px-4 py-3.5">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-mist-200">
              <FileCode2 size={13} className="text-mist-400" /> 活跃 AI 会话 ({sessions.length})
            </div>
            {sessions.length === 0 && <div className="text-[11px] text-mist-500">暂无会话记录</div>}
            <div className="space-y-1.5">
              {sessions.slice(0, 4).map((s) => (
                <div key={s.file} className="flex items-center gap-2 text-[11px]">
                  <span className="chip bg-ink-750 font-mono text-mist-300">{s.platform}</span>
                  <span className="min-w-0 flex-1 truncate text-mist-400">{s.currentTask ?? '未绑定任务'}</span>
                  <span className="shrink-0 text-mist-500">{relTime(new Date(s.lastSeen ?? 0).getTime())}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card px-4 py-3.5 text-[11px] leading-5 text-mist-400">
            <div className="mb-2 text-xs font-semibold text-mist-200">项目配置</div>
            <div className="grid grid-cols-2 gap-y-1.5">
              <span>开发者</span><span className="text-right text-mist-200">{meta.developer ?? '—'}</span>
              <span>workflow.md</span><span className="text-right text-mist-200">{meta.hasWorkflow ? '✓ 已配置' : '—'}</span>
              <span>config.yaml</span><span className="text-right text-mist-200">{meta.configExists ? '✓ 已配置' : '—'}</span>
              <span>packages</span><span className="text-right text-mist-200">{meta.packages.length ? meta.packages.join(' / ') : '—'}</span>
              <span>规范文档</span><span className="text-right text-mist-200">{countSpec(snapshot)} 个</span>
              <span>最近写作</span><span className="text-right text-mist-200">{lastActive ? relTime(lastActive) : '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function countSpec(snapshot: { spec: Array<{ type: string; children?: unknown[] }> }): number {
  let n = 0
  const walk = (nodes: Array<{ type: string; children?: Array<never> }>): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'file') n += 1
      else walk(node.children as never)
    }
  }
  walk(snapshot.spec as never)
  return n
}
