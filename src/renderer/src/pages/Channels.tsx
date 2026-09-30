import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Radio,
  RefreshCw,
  Send,
  Plus,
  Trash2,
  OctagonX,
  Play,
  Users,
  MessageSquare,
  Zap,
  CircleCheck,
  AlertCircle,
  Loader2,
  Timer,
  Sparkles,
  RadioTower,
  X
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { fmtIso } from '../utils/format'
import { confirmDialog, promptDialog } from '../components/Dialogs'
import { MarkdownView } from '../components/MarkdownView'
import type { ChannelEvent, ChannelSummary } from '../../../shared/types'
import type { JSX } from 'react'

const KIND_STYLE: Record<string, { icon: JSX.Element; cls: string; label: string }> = {
  message: { icon: <MessageSquare size={11} />, cls: 'bg-sky-500/15 text-sky-300', label: '消息' },
  create: { icon: <Sparkles size={11} />, cls: 'bg-leaf-dim/20 text-leaf-soft', label: '创建' },
  progress: { icon: <Loader2 size={11} />, cls: 'bg-amber-500/15 text-amber-300', label: '进度' },
  turn_finished: { icon: <CircleCheck size={11} />, cls: 'bg-emerald-500/15 text-emerald-300', label: '回合完成' },
  done: { icon: <CircleCheck size={11} />, cls: 'bg-emerald-500/15 text-emerald-300', label: '完成' },
  error: { icon: <AlertCircle size={11} />, cls: 'bg-rose-500/15 text-rose-300', label: '错误' },
  killed: { icon: <OctagonX size={11} />, cls: 'bg-rose-500/15 text-rose-300', label: '已终止' }
}

function kindStyle(kind: string): { icon: JSX.Element; cls: string; label: string } {
  return (
    KIND_STYLE[kind] ?? {
      icon: <Zap size={11} />,
      cls: 'bg-ink-700 text-mist-300',
      label: kind
    }
  )
}

export function ChannelsPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [scopeFilter, setScopeFilter] = useState<'project' | 'all'>('project')
  const [activeName, setActiveName] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionOutput, setActionOutput] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(true)

  const reload = useCallback(async (): Promise<void> => {
    const res = await api.channelList()
    if (res.ok && res.channels) {
      setChannels(res.channels)
      setError(null)
    } else {
      setError(res.error ?? '读取 channels 失败')
    }
  }, [])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), 3000)
    return () => clearInterval(t)
  }, [reload, snapshot?.meta.root])

  const visible = useMemo(
    () => channels.filter((c) => scopeFilter === 'all' || c.scope === 'project'),
    [channels, scopeFilter]
  )
  const active = visible.find((c) => `${c.bucket}/${c.name}` === activeName) ?? visible[0] ?? null

  useEffect(() => {
    if (liveRef.current && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [active?.events.length])

  const send = async (): Promise<void> => {
    if (!active || !input.trim()) return
    setBusy(true)
    const res = await api.channelSend(active.name, input.trim())
    setBusy(false)
    if (res.ok) {
      setInput('')
      pushToast({ kind: 'success', title: '已发送', body: `→ ${active.name}（as panel-ui）` })
      setTimeout(() => void reload(), 400)
    } else {
      pushToast({ kind: 'error', title: '发送失败', body: res.error })
    }
  }

  const runAction = async (args: string[], label: string, timeoutMs?: number): Promise<void> => {
    setBusy(true)
    setActionOutput(null)
    const res = await api.channelAction(args)
    setBusy(false)
    if (res.output) setActionOutput(res.output)
    if (res.ok) {
      pushToast({ kind: 'success', title: label, body: res.output ? '输出已追加到底部' : undefined })
      await reload()
    } else {
      pushToast({ kind: 'error', title: `${label}失败`, body: res.error })
    }
    void timeoutMs
  }

  const createChannel = async (): Promise<void> => {
    const name = await promptDialog({ title: '新建频道', label: '频道名称（如 architecture-review）', placeholder: 'architecture-review' })
    if (name === null) return
    // 确认框的布尔结果映射回频道类型：确定 = forum，取消 = chat
    const isForum = await confirmDialog({
      title: '是否创建为 forum（线程化看板）？',
      message: '确定 = forum（线程化看板），取消 = chat（普通频道）。',
      confirmText: 'forum'
    })
    await runAction(['create', name, '--type', isForum ? 'forum' : 'chat', '--by', 'panel-ui'], '创建频道')
  }

  const spawnWorker = async (): Promise<void> => {
    if (!active) return
    const provider = await promptDialog({ title: '启动 worker', label: '提供方（claude / codex）', defaultValue: 'codex' })
    if (provider === null) return
    const as = await promptDialog({ title: '启动 worker', label: 'worker 命名（--as，如 reviewer）', defaultValue: `${provider}-worker` })
    if (as === null) return
    await runAction(
      ['spawn', active.name, '--provider', provider, '--as', as, '--cwd', '.', '--timeout', '30m'],
      '启动 worker'
    )
  }

  const removeChannel = async (channel: ChannelSummary): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除频道「${channel.name}」？`,
      message: '事件日志将被移除。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    await runAction(['rm', channel.name], '删除频道')
  }

  const threadGroups = useMemo(() => {
    if (!active || active.type !== 'forum') return null
    const map = new Map<string, ChannelEvent[]>()
    for (const e of [...active.events].reverse()) {
      const key = e.thread ?? '(无线程)'
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    return map
  }, [active])

  /* 任务派发台（R8）：面板作为发起方，把任务/需求派给 AI worker */
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchTask, setDispatchTask] = useState('')
  const [dispatchText, setDispatchText] = useState('')
  const [dispatching, setDispatching] = useState(false)

  const doDispatch = async (): Promise<void> => {
    if (dispatching) return
    if (!dispatchTask && !dispatchText.trim()) {
      pushToast({ kind: 'error', title: '请选择任务或填写需求描述' })
      return
    }
    setDispatching(true)
    try {
      const res = await api.channelDispatch({
        taskDir: dispatchTask || undefined,
        text: dispatchText.trim() || undefined
      })
      if (res.ok && res.channel) {
        pushToast({ kind: 'success', title: '已派发', body: `频道 ${res.channel}——AI worker 的事件回报将实时出现在频道里` })
        setDispatchOpen(false)
        setDispatchTask('')
        setDispatchText('')
        setTimeout(() => void reload(), 500)
      } else {
        pushToast({ kind: 'error', title: '派发失败', body: res.error })
      }
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div className="relative flex h-full min-w-0 animate-fade-in">
      {/* 左列：频道列表 */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-ink-700">
        <div className="space-y-2.5 border-b border-ink-700 px-4 py-3">
          <div className="flex items-center gap-2">
            <Radio size={14} className="text-leaf" />
            <span className="text-[13px] font-semibold text-mist-100">AI 频道</span>
            <span className="chip bg-ink-750 text-[10px] text-mist-400">{visible.length}</span>
            <button onClick={() => void reload()} className="btn-ghost ml-auto justify-center px-1.5" title="刷新">
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="flex gap-1.5">
            {(
              [
                ['project', '本项目'],
                ['all', '全部（含全局）']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setScopeFilter(id)}
                className={clsx(
                  'chip border transition-colors',
                  scopeFilter === id ? 'border-leaf-dim/50 bg-leaf-dim/15 text-leaf-soft' : 'border-ink-600 text-mist-400'
                )}
              >
                {label}
              </button>
            ))}
            <button onClick={() => setDispatchOpen(true)} className="btn-outline ml-auto text-[11px]" title="把一个任务或一句话需求派发给 AI worker（自动建频道 + 结构化指令）">
              <Send size={11} /> 派活给 AI
            </button>
            <button onClick={createChannel} className="btn-primary" title="channel create">
              <Plus size={11} /> 新建
            </button>
          </div>
          <div className="text-[10.5px] text-mist-600">
            3 秒轮询 · 以 <code>panel-ui</code> 参与
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-300">{error}</div>}
          {visible.map((c) => (
            <button
              key={`${c.bucket}/${c.name}`}
              onClick={() => setActiveName(`${c.bucket}/${c.name}`)}
              className={clsx(
                'mb-1.5 w-full rounded-lg border px-3 py-2 text-left transition-colors',
                active?.name === c.name && active?.bucket === c.bucket
                  ? 'border-leaf-dim/40 bg-leaf-dim/10'
                  : 'border-transparent hover:border-ink-600 hover:bg-ink-750/50'
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={clsx('chip text-[9.5px]', c.scope === 'project' ? 'bg-leaf-dim/15 text-leaf-soft' : 'bg-violet-500/15 text-violet-300')}>
                  {c.scope === 'project' ? '本项目' : '全局'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-mist-100">{c.name}</span>
                <span className="chip bg-ink-750 shrink-0 text-[9.5px] text-mist-400">{c.type}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-mist-500">
                <Users size={10} /> {c.participants.slice(0, 3).join(', ')}
                {c.participants.length > 3 && ` +${c.participants.length - 3}`}
                <span className="ml-auto shrink-0">{c.eventCount} 事件 · {c.lastEventAt ? fmtIso(c.lastEventAt).slice(5) : ''}</span>
              </div>
            </button>
          ))}
          {visible.length === 0 && !error && (
            <div className="grid place-items-center gap-2 py-14 text-center text-xs text-mist-500">
              <RadioTower size={22} className="text-mist-600" />
              <div>
                <div className="font-mono text-[10.5px] text-mist-400">trellis channel create &lt;name&gt; --by main</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右列：事件流 */}
      {active ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-2.5">
            <span className="font-mono text-xs font-semibold text-mist-100">{active.name}</span>
            <span className="chip bg-ink-750 text-[9.5px] text-mist-400">{active.bucket}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={spawnWorker} disabled={busy} className="btn-ghost text-[11px]" title="channel spawn">
                <Play size={11} /> 启动 worker
              </button>
              <button
                onClick={() => void runAction(['interrupt', active.name, '--as', 'panel-ui'], '软中断')}
                disabled={busy}
                className="btn-ghost text-[11px]"
                title="channel interrupt —— worker 保留 session 按新指令继续"
              >
                <Timer size={11} /> 中断
              </button>
              <button
                onClick={() => void removeChannel(active)}
                disabled={busy}
                className="btn-ghost justify-center px-2 text-rose-300"
                title="channel rm"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {/* forum 线程概览 */}
          {threadGroups && (
            <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-ink-700 px-4 py-2">
              {[...threadGroups.entries()].map(([thread, evs]) => (
                <span key={thread} className="chip shrink-0 bg-sky-500/10 text-[10px] text-sky-300">
                  {thread} · {evs.length}
                </span>
              ))}
            </div>
          )}

          <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {active.events.map((e, i) => {
              // 对话视图（09-30）：message 渲染为气泡（我方右侧 / worker 左侧），
              // 系统事件收窄为紧凑单行，不再与文本等权展示
              if (e.kind === 'message' && e.text) {
                const mine = ['panel', 'panel-ui', 'main'].includes(e.by)
                return (
                  <div key={`${e.seq}-${i}`} className={clsx('mb-3 flex', mine ? 'justify-end' : 'justify-start')}>
                    <div className={clsx('max-w-[85%] min-w-0', mine ? 'items-end' : 'items-start')}>
                      <div className={clsx('mb-0.5 flex items-baseline gap-2 text-[9.5px] text-mist-600', mine && 'justify-end')}>
                        <span className="font-mono font-medium text-mist-400">{e.by}</span>
                        <span>{e.ts ? fmtIso(e.ts) : ''}</span>
                      </div>
                      <div
                        className={clsx(
                          'rounded-xl border px-3 py-2 text-[11.5px] leading-5 text-mist-200',
                          mine ? 'border-leaf-dim/30 bg-leaf-dim/10' : 'border-ink-700 bg-ink-850/80'
                        )}
                      >
                        {e.text.length > 6000 ? (
                          <pre className="whitespace-pre-wrap break-words font-sans">{`${e.text.slice(0, 6000)}\n…（超长截断）`}</pre>
                        ) : (
                          <MarkdownView content={e.text} />
                        )}
                      </div>
                    </div>
                  </div>
                )
              }
              const st = kindStyle(e.kind)
              const detail = e.status || (e.kind === 'progress' ? '' : '')
              return (
                <div key={`${e.seq}-${i}`} className="mb-1 flex items-center gap-2 text-[10px] text-mist-600">
                  <span className={clsx('flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px]', st.cls)}>
                    {st.icon} {st.label}
                  </span>
                  <span className="font-mono text-mist-500">{e.by}</span>
                  {e.thread && <span className="chip bg-sky-500/10 text-[9px] text-sky-300">{e.thread}</span>}
                  {detail && <span className="truncate text-mist-500">{detail}</span>}
                  <span className="ml-auto shrink-0">{e.ts ? fmtIso(e.ts) : ''}</span>
                </div>
              )
            })}
            {active.events.length === 0 && <div className="py-10 text-center text-xs text-mist-500">暂无事件</div>}
          </div>

          {actionOutput && (
            <div className="mx-4 mb-2 max-h-28 shrink-0 overflow-y-auto rounded-lg border border-ink-600 bg-ink-950 p-2.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-mist-500">CLI 输出</span>
                <button onClick={() => setActionOutput(null)} className="text-mist-500 hover:text-mist-200">
                  <X size={11} />
                </button>
              </div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] leading-4 text-mist-400">{actionOutput}</pre>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-2 border-t border-ink-700 px-4 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send()
              }}
              placeholder={`发送到 ${active.name}…`}
              className="field flex-1"
            />
            <button onClick={() => void send()} disabled={busy || !input.trim()} className="btn-primary disabled:opacity-40">
              <Send size={12} /> 发送
            </button>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center text-xs text-mist-500">选择或创建一个频道</div>
      )}

      {/* 派发弹窗 */}
      {dispatchOpen && (
        <div className="absolute inset-0 z-50 grid animate-fade-in place-items-center bg-black/50 backdrop-blur-sm" onClick={() => !dispatching && setDispatchOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-[520px] overflow-hidden rounded-2xl border border-ink-600 bg-ink-850 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3.5">
              <RadioTower size={15} className="text-leaf" />
              <span className="text-sm font-semibold text-mist-50">派活给 AI</span>
              <span className="chip border border-leaf-dim/30 bg-leaf-dim/10 text-[10px] text-leaf-soft">自动建频道 · 结构化指令 · 事件实时回流</span>
              <button onClick={() => setDispatchOpen(false)} className="btn-ghost ml-auto px-1.5 py-1" title="关闭">
                <X size={15} />
              </button>
            </div>
            <div className="space-y-3.5 p-5">
              <div>
                <label className="mb-1.5 block text-[11px] text-mist-400">派发一个看板任务（可选）</label>
                <select value={dispatchTask} onChange={(e) => setDispatchTask(e.target.value)} className="field">
                  <option value="">— 不派任务，派一句话需求 —</option>
                  {snapshot.tasks.map((t) => (
                    <option key={t.dirName} value={t.dirName}>
                      {t.record?.title ?? t.dirName}（{t.record?.status ?? ''}）
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] leading-4 text-mist-600">
                  选中任务后，指令会自动携带任务目录、PRD 摘录与子任务清单，AI worker 可直接开工。
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] text-mist-400">{dispatchTask ? '派发人补充说明（可选）' : '一句话需求 *'}</label>
                <textarea
                  value={dispatchText}
                  onChange={(e) => setDispatchText(e.target.value)}
                  rows={3}
                  placeholder={dispatchTask ? '例如：重点核对验收标准第 2 条' : '例如：帮我检查所有任务的状态字段是否与 Jira 同步'}
                  className="field resize-y"
                />
              </div>
              <div className="rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2.5 text-[11px] leading-5 text-mist-500">
                派发后自动创建 dispatch-* 频道并以 panel-ui 身份发送指令；AI worker（trellis channel spawn 启动）的
                progress / done 事件会实时出现在频道事件流里，可随时插话引导。
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-ink-700 px-5 py-3">
              <span className="ml-auto text-[10.5px] text-mist-600">{snapshot?.meta.name}</span>
              <button onClick={() => setDispatchOpen(false)} className="btn-outline" disabled={dispatching}>取消</button>
              <button onClick={() => void doDispatch()} disabled={dispatching || (!dispatchTask && !dispatchText.trim())} className="btn-primary disabled:opacity-50">
                {dispatching ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {dispatching ? '派发中…' : '立即派发'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
