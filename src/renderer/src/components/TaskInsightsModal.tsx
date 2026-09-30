import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Copy, Loader2, MessagesSquare, Radio, ShieldCheck, X } from 'lucide-react'
import type { ContextExpectEntry, TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { clsx } from 'clsx'

/**
 * 任务透视 v3（任务体检卡，2026-09-30 按用户反馈第三次重做）。
 * 产品定位：回答三个问题——这个任务健康吗？下一步该干嘛？派活弹药齐不齐？
 * v1/v2 的教训：workflow.md 的通用阶段是框架文档不是任务信息，画出来就是花瓶；
 * 本版每一条信息都关于本任务，每个建议都带动作。
 */

interface ExpectEntry {
  file: string
  reason: string
  exists: boolean
  size: number
  verdict: string
}

interface ExpectData {
  ok: true
  implement: { present: boolean; totalBytes: number; entries: ExpectEntry[] }
  check: { present: boolean; totalBytes: number; entries: ExpectEntry[] }
  caps: { perFile: number; total: number }
}

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`
}

const VERDICT_LABEL: Record<string, string> = {
  full: '完整内联',
  truncate: '超限·将截断',
  index: '超预算·降索引',
  missing: '文件缺失'
}

interface Row {
  name: string
  /** 缺失时的后果（人话；空串=可选无后果） */
  missImpact: string
  isDir?: boolean
}

const ROWS: Row[] = [
  { name: 'prd.md', missImpact: '' },
  { name: 'design.md', missImpact: '' },
  { name: 'implement.md', missImpact: '' },
  { name: 'implement.jsonl', missImpact: '实现子代理将零规范上下文开工', isDir: false },
  { name: 'check.jsonl', missImpact: '检查子代理将零质量基准可对照', isDir: false },
  { name: 'research', missImpact: '', isDir: true }
]

export function TaskInsightsModal({ task, onClose, onReadArtifact }: { task: TaskInfo; onClose: () => void; onReadArtifact?: (fileName: string) => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const setPage = useApp((s) => s.setPage)
  const sessions = useApp((s) => s.snapshot?.sessions ?? [])

  const [expect, setExpect] = useState<ExpectData | { ok: false; error: string } | null>(null)
  const [channels, setChannels] = useState<Array<{ name: string; eventCount: number }>>([])

  useEffect(() => {
    let alive = true
    void api.taskContextExpect(task.dirName).then((res) => {
      if (alive) setExpect(res)
    })
    // 关联的审阅频道（本任务前缀）
    void api.channelList().then((res) => {
      if (!alive) return
      if (res.ok && res.channels) {
        const mine = res.channels
          .filter((c) => c.name === `tp-review-${task.dirName}` || c.name.startsWith(`tp-review-${task.dirName}-`))
          .map((c) => ({ name: c.name, eventCount: c.eventCount }))
        setChannels(mine)
      }
    })
    return () => {
      alive = false
    }
  }, [task.dirName])

  const has = (name: string): boolean =>
    task.artifacts.some((a) => (name.endsWith('/') ? a.name === name.slice(0, -1) || a.name.startsWith(name) : a.name === name))
  const sizeOf = (name: string): number | null => {
    const a = task.artifacts.find((x) => x.name === name)
    return a ? a.size : null
  }

  const status = (task.record?.status ?? '').toLowerCase()
  const statusLabel = task.record?.status ?? '未知'

  /* ---- 体检：问题清单（每条都是可行动的事实） ---- */
  const problems: string[] = []
  if (task.parseError) problems.push('task.json 无法读取——先修复它，其他一切展示都不可信')
  for (const r of ROWS) {
    if (r.isDir || !r.missImpact) continue
    if (!has(r.name)) {
      const needed = r.name === 'implement.jsonl' ? ['in_progress', 'review', 'completed'] : ['in_progress', 'review']
      if (needed.includes(status)) problems.push(`缺 ${r.name}：${r.missImpact}`)
    }
  }
  let overBudget = 0
  if (expect?.ok) {
    for (const g of [expect.implement, expect.check]) {
      overBudget += g.entries.filter((e) => e.verdict === 'truncate' || e.verdict === 'index' || e.verdict === 'missing').length
    }
  }
  if (overBudget > 0) problems.push(`${overBudget} 条上下文引用超限/缺失——注入将截断或降级（见下表）`)

  /* ---- 下一步建议（规则化，按优先级取第一条；动作按钮常驻） ---- */
  const suggestion = useMemo((): { text: string; tone: 'go' | 'warn' | 'done' } => {
    if (task.parseError) return { text: '优先修复 task.json（当前无法解析）——修复后本页所有判断才可信。', tone: 'warn' }
    if (task.archived) return { text: '任务已归档。可回看审阅对话，或复制交接包开新会话做后续迭代。', tone: 'done' }
    if (status === 'planning' && has('prd.md')) return { text: 'PRD 已就绪——可以进入执行：回 AI 工具对任务说「继续」，或先派一次只读审阅验证计划。', tone: 'go' }
    if (status === 'planning') return { text: '还在规划阶段且没有 PRD——回 AI 工具描述需求让它起草，或在 AI 工具里继续 brainstorm。', tone: 'warn' }
    if ((status === 'in_progress' || status === 'review') && overBudget > 0)
      return { text: '执行中但上下文引用有超限——子代理拿到的是截断/索引版，关键 spec 建议拆小后重写清单。', tone: 'warn' }
    if (status === 'in_progress' || status === 'review') return { text: '执行/检查中——材料齐备。完成后回 AI 工具走收尾（提交并 task.py archive），面板不代归档。', tone: 'go' }
    if (status === 'completed') return { text: '标记已完成——但归档请走 AI 工具的 task.py archive（面板不代归档）。', tone: 'done' }
    return { text: `记录阶段为「${statusLabel}」（自定义状态，按原值显示）。`, tone: 'warn' }
  }, [task.parseError, task.archived, status, overBudget, statusLabel])

  const boundSessions = sessions.filter((s) => s.currentTask === task.dirName)

  const copyHandoff = async (): Promise<void> => {
    const res = await api.taskHandoffBuild(task.dirName, '只核对与阅读，不开始实施', false)
    if (res.ok) {
      await api.copyToClipboard(res.text)
      pushToast({ kind: 'success', title: '交接包已复制', body: '粘贴到任意 AI 会话接续' })
    } else {
      pushToast({ kind: 'error', title: '生成失败', body: res.error })
    }
  }

  const artOk = ROWS.filter((r) => has(r.name)).length

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        {/* 头 */}
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <span className="text-xs font-semibold text-mist-100">任务体检</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">{task.record?.title ?? task.dirName}</span>
          <button onClick={onClose} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* 状态带 */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2">
            <span className="chip bg-leaf-dim/15 text-leaf-soft">记录阶段：{statusLabel}</span>
            <span className="chip bg-ink-750 text-mist-300">
              材料 {artOk}/{ROWS.length}
            </span>
            {problems.length > 0 ? (
              <span className="chip bg-amber-500/10 text-amber-300">{problems.length} 个需要注意</span>
            ) : (
              <span className="chip bg-leaf/10 text-leaf-soft">无异常</span>
            )}
            <span className="ml-auto font-mono text-[10px] text-mist-600">{task.dirName}</span>
          </div>

          {/* 问题清单 */}
          {problems.length > 0 && (
            <div className="space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5">
              {problems.map((p, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] leading-5 text-amber-300/90">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                  {p}
                </div>
              ))}
            </div>
          )}

          {/* 下一步 */}
          <div
            className={clsx(
              'rounded-lg border p-3',
              suggestion.tone === 'go' && 'border-leaf-dim/40 bg-leaf-dim/10',
              suggestion.tone === 'warn' && 'border-amber-500/30 bg-amber-500/5',
              suggestion.tone === 'done' && 'border-ink-700 bg-ink-850/40'
            )}
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-mist-500">下一步</div>
            <div className="text-[11.5px] leading-5 text-mist-200">{suggestion.text}</div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button onClick={() => void copyHandoff()} className="btn-outline text-[11px]">
                <Copy size={11} /> 复制交接包
              </button>
              <button
                onClick={() => {
                  onClose()
                  setPage('channels')
                }}
                className="btn-ghost text-[11px]"
                title="审阅/起草的完整对话都在 AI 频道页"
              >
                <Radio size={11} /> 去 AI 频道回看
              </button>
              {!task.archived && (
                <button
                  onClick={() => {
                    onClose()
                    // 复用工作台的派发入口：由父级打开，这里仅提示（避免双重弹窗）
                    pushToast({ kind: 'info', title: '在任务头部点紫色盾牌', body: '即可派 Codex 只读审阅' })
                  }}
                  className="btn-ghost text-[11px]"
                >
                  <ShieldCheck size={11} /> 派只读审阅
                </button>
              )}
            </div>
          </div>

          {/* 交付物清单 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-mist-300">交付物清单</div>
            <div className="overflow-hidden rounded-lg border border-ink-700">
              {ROWS.map((r, i) => {
                const ok = has(r.name)
                const size = sizeOf(r.name)
                const isJsonl = r.name.endsWith('.jsonl')
                return (
                  <div key={r.name} className={clsx('flex items-center gap-2.5 px-3 py-2 text-[11.5px]', i % 2 && 'bg-ink-850/40')}>
                    <span className={clsx('font-mono', ok ? 'text-leaf' : 'text-mist-600')}>{ok ? '✓' : '○'}</span>
                    <span className={clsx('font-mono text-[11px]', ok ? 'text-mist-100' : 'text-mist-500')}>{r.name}</span>
                    {ok && size !== null && <span className="font-mono text-[10px] text-mist-600">{kb(size)}</span>}
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-600">
                      {!ok && r.missImpact ? r.missImpact : ''}
                    </span>
                    {ok && !r.isDir && /\.(md|jsonl)$/i.test(r.name) && onReadArtifact && (
                      <button
                        onClick={() => {
                          onReadArtifact(r.name)
                          onClose()
                        }}
                        className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10.5px] text-leaf-soft"
                        title="在右侧阅读区打开"
                      >
                        <BookOpen size={11} /> 阅读
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 上下文体检 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-mist-300">
              上下文体检
              <span className="ml-2 font-normal text-[10px] text-mist-600">派单时子代理将被注入的内容（预期，≠实际读取）</span>
            </div>
            {!expect ? (
              <div className="flex h-10 items-center justify-center text-mist-500">
                <Loader2 size={13} className="animate-spin" />
              </div>
            ) : !expect.ok ? (
              <div className="text-[11px] text-rose-300">{expect.error}</div>
            ) : (
              <div className="space-y-2.5">
                {([['implement.jsonl', expect.implement], ['check.jsonl', expect.check]] as const).map(([label, g]) => (
                  <div key={label} className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-mist-200">{label}</span>
                      {g.present ? (
                        <>
                          <span className="font-mono text-[10px] text-mist-500">
                            {g.entries.length} 条 · {kb(g.totalBytes)}/{kb(expect.caps.total)}
                          </span>
                          <span className="ml-auto flex flex-wrap gap-1">
                            {g.entries.map((e, i) => (
                              <span key={i} className={clsx('chip text-[9px]', VERDICT_LABEL[e.verdict] ? 'bg-ink-750 text-mist-400' : '')} title={`${e.file} — ${VERDICT_LABEL[e.verdict] ?? e.verdict}`}>
                                {VERDICT_LABEL[e.verdict] ?? e.verdict}
                              </span>
                            ))}
                          </span>
                        </>
                      ) : (
                        <span className="chip bg-ink-750 text-mist-500">未创建</span>
                      )}
                    </div>
                  </div>
                ))}
                {expect.ok && (expect.implement.present || expect.check.present) && (
                  <details className="rounded-lg border border-ink-700 bg-ink-950">
                    <summary className="cursor-pointer px-2.5 py-1.5 text-[10.5px] text-mist-400">逐条明细</summary>
                    <div className="max-h-44 overflow-y-auto px-2.5 pb-2">
                      {([['implement', expect.implement], ['check', expect.check]] as const).map(([gname, g]) =>
                        g.entries.map((e, i) => (
                          <div key={`${gname}${i}`} className="flex items-center gap-2 border-b border-ink-800/60 py-1 text-[10.5px] last:border-0">
                            <span className="w-14 shrink-0 font-mono text-mist-600">{gname.slice(0, 4)}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-mist-300" title={e.file}>
                              {e.file}
                            </span>
                            <span className="font-mono text-[9.5px] text-mist-600">{e.exists ? kb(e.size) : '—'}</span>
                            <span className="w-20 shrink-0 text-right text-mist-500">{VERDICT_LABEL[e.verdict] ?? e.verdict}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* 会话与频道 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold text-mist-300">会话与对话</div>
            <div className="space-y-1.5">
              {boundSessions.length > 0 ? (
                boundSessions.map((s) => (
                  <div key={s.file} className="flex items-center gap-2 text-[11px] text-mist-300">
                    <span className="chip bg-leaf-dim/15 text-leaf-soft">会话绑定</span>
                    <span className="font-mono">{s.platform}</span>
                    <span className="text-mist-600">最后记录 {s.lastSeen ? new Date(s.lastSeen).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-mist-600">当前没有 AI 会话绑定此任务</div>
              )}
              {channels.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-[11px] text-mist-300">
                  <span className="chip bg-violet-500/15 text-violet-300">
                    <MessagesSquare size={9} className="mr-1 inline" />
                    审阅对话
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-mist-400">{c.name}</span>
                  <span className="font-mono text-[10px] text-mist-600">{c.eventCount} 事件</span>
                  <button
                    onClick={() => {
                      onClose()
                      setPage('channels')
                    }}
                    className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10.5px] text-leaf-soft"
                  >
                    回看
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
