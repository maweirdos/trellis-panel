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
    const name = prompt('频道名称（如 architecture-review）：')
    if (!name) return
    const type = confirm('是否创建为 forum（线程化看板）？\n确定 = forum，取消 = chat') ? 'forum' : 'chat'
    await runAction(['create', name, '--type', type, '--by', 'panel-ui'], '创建频道')
  }

  const spawnWorker = async (): Promise<void> => {
    if (!active) return
    const provider = prompt('worker 提供方（claude / codex）：', 'codex')
    if (!provider) return
    const as = prompt('worker 命名（--as，如 reviewer）：', `${provider}-worker`)
    if (!as) return
    await runAction(
      ['spawn', active.name, '--provider', provider.trim(), '--as', as.trim(), '--cwd', '.', '--timeout', '30m'],
      '启动 worker'
    )
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

  return (
    <div className="flex h-full min-w-0 animate-fade-in">
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
            <button onClick={createChannel} className="btn-primary ml-auto" title="channel create">
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
                onClick={() => {
                  if (confirm(`确认删除频道「${active.name}」？事件日志将被移除。`)) void runAction(['rm', active.name], '删除频道')
                }}
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
              const st = kindStyle(e.kind)
              return (
                <div key={`${e.seq}-${i}`} className="mb-2 flex items-start gap-2.5">
                  <span className={clsx('mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px]', st.cls)}>
                    {st.icon} {st.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[10.5px] font-medium text-mist-300">{e.by}</span>
                      {e.thread && <span className="chip bg-sky-500/10 text-[9px] text-sky-300">{e.thread}</span>}
                      <span className="text-[9.5px] text-mist-600">{e.ts ? fmtIso(e.ts) : ''}</span>
                    </div>
                    {e.text && (
                      <div className="mt-0.5 whitespace-pre-wrap break-words rounded-lg border border-ink-700/70 bg-ink-850/60 px-2.5 py-1.5 text-[11.5px] leading-5 text-mist-200">
                        {e.text.length > 2000 ? `${e.text.slice(0, 2000)}\n…（截断，完整内容见 CLI --raw）` : e.text}
                      </div>
                    )}
                    {e.status && <div className="mt-0.5 text-[10.5px] text-mist-500">状态：{e.status}</div>}
                  </div>
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
    </div>
  )
}
