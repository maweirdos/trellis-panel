import { useMemo } from 'react'
import { Users2, GitCommitHorizontal, NotebookPen, Bot, Share2, Star } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { StatusBadge, PriorityBadge } from '../components/badges'
import { statusLabel } from '../utils/labels'
import { fmtIso, relTime, taskDateLabel } from '../utils/format'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { TaskInfo } from '../../../shared/types'

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

export function TeamPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)

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
    return items.sort((a, b) => b.at - a.at).slice(0, 60)
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
        <div className="flex items-center gap-2">
          <Users2 size={16} className="text-mist-400" />
          <h1 className="text-base font-semibold text-mist-50">团队协作</h1>
          <span className="text-[11px] text-mist-500">
            {members.length} 名成员 · {snapshot.tasks.length} 个进行中任务 · {snapshot.sessions.length} 个 AI 会话
          </span>
        </div>

        {currentTask?.record && (
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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* workload */}
          <div className="card lg:col-span-2">
            <div className="border-b border-ink-700 px-4 py-2.5 text-xs font-semibold text-mist-200">
              成员工作量
            </div>
            <div className="space-y-3 p-4">
              {members.map((m) => {
                const done = m.byStatus['已完成'] ?? 0
                return (
                  <div key={m.name}>
                    <div className="mb-1 flex items-center gap-2 text-[11px]">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-leaf-deep/60 text-[10px] font-bold text-leaf">
                        {m.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="font-medium text-mist-200">{m.name}</span>
                      <span className="text-mist-500">{m.total} 任务 · 完成 {done}</span>
                      <span className="ml-auto text-mist-600">{m.lastActive ? relTime(m.lastActive) : '—'}</span>
                    </div>
                    <div className="flex h-2 gap-px overflow-hidden rounded-full bg-ink-750">
                      {(['规划中', '进行中', '评审中', '已完成'] as const).map((label, i) => {
                        const v = m.byStatus[label] ?? 0
                        if (!v) return null
                        const colors = ['bg-sky-500/70', 'bg-amber-500/70', 'bg-violet-500/70', 'bg-emerald-500/70']
                        return (
                          <div
                            key={label}
                            className={clsx(colors[i], 'h-full')}
                            style={{ width: `${(v / m.total) * 100}%` }}
                            title={`${label} ${v}`}
                          />
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {members.length === 0 && <div className="py-6 text-center text-[11px] text-mist-500">暂无数据</div>}
            </div>
          </div>

          {/* activity feed */}
          <div className="card lg:col-span-3">
            <div className="flex items-center gap-1.5 border-b border-ink-700 px-4 py-2.5 text-xs font-semibold text-mist-200">
              <GitCommitHorizontal size={13} className="text-mist-400" /> 团队动态
            </div>
            <div className="max-h-[520px] divide-y divide-ink-700/50 overflow-y-auto">
              {feed.map((it, i) => (
                <div key={i} className="flex items-center gap-2.5 px-4 py-2 text-xs">
                  <span
                    className={clsx(
                      'grid h-5 w-5 shrink-0 place-items-center rounded-full',
                      it.kind === 'task' && 'bg-amber-500/15 text-amber-300',
                      it.kind === 'journal' && 'bg-emerald-500/15 text-emerald-300',
                      it.kind === 'session' && 'bg-violet-500/15 text-violet-300'
                    )}
                  >
                    {it.kind === 'task' && <GitCommitHorizontal size={11} />}
                    {it.kind === 'journal' && <NotebookPen size={11} />}
                    {it.kind === 'session' && <Bot size={11} />}
                  </span>
                  <span className="shrink-0 font-medium text-mist-300">{it.who}</span>
                  {it.kind === 'task' && it.taskDir ? (
                    <button
                      onClick={() => {
                        const t = snapshot.tasks.find((x) => x.dirName === it.taskDir)
                        if (t) showTask(t.dirName)
                        else showTask(it.taskDir!, true)
                      }}
                      className="min-w-0 flex-1 truncate text-left text-mist-400 hover:text-leaf-soft"
                    >
                      {it.what}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-mist-400">{it.what}</span>
                  )}
                  <span className="shrink-0 text-[10px] text-mist-600">{fmtIso(new Date(it.at).toISOString())}</span>
                </div>
              ))}
              {feed.length === 0 && (
                <div className="py-10 text-center text-[11px] text-mist-500">暂无动态</div>
              )}
            </div>
          </div>
        </div>

        {/* member task matrix */}
        <div className="card">
          <div className="border-b border-ink-700 px-4 py-2.5 text-xs font-semibold text-mist-200">
            成员任务明细
          </div>
          <div className="divide-y divide-ink-700/50">
            {members.map((m) => {
              const mine = snapshot.tasks.filter((t) => (t.record?.assignee || t.record?.creator) === m.name)
              return (
                <div key={m.name} className="px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium text-mist-200">
                    {m.name}
                    <span className="text-[10.5px] font-normal text-mist-500">{mine.length} 个进行中任务</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {mine.map((t) => (
                      <button
                        key={t.dirName}
                        onClick={() => showTask(t.dirName)}
                        className="group flex max-w-[320px] items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-left transition-colors hover:border-leaf-dim/40"
                      >
                        <PriorityBadge priority={t.record?.priority ?? ''} />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-mist-200">
                          {t.record?.title ?? taskDateLabel(t.dirName, t.date)}
                        </span>
                        <StatusBadge status={t.record?.status ?? ''} />
                      </button>
                    ))}
                    {mine.length === 0 && <span className="text-[11px] text-mist-600">无进行中任务</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
