import { useCallback, useEffect, useRef, useState } from 'react'
import { Radio, Send, RefreshCw, Users, Hash } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { fmtIso } from '../utils/format'
import type { JSX } from 'react'
import type { ChannelSummary } from '../../../shared/types'

const KIND_STYLE: Record<string, { chip: string; icon: string }> = {
  create: { chip: 'bg-leaf/10 text-leaf-soft', icon: '✦' },
  message: { chip: 'bg-sky-500/10 text-sky-300', icon: '💬' },
  progress: { chip: 'bg-amber-500/10 text-amber-300', icon: '⏳' },
  done: { chip: 'bg-emerald-500/10 text-emerald-300', icon: '✅' },
  error: { chip: 'bg-rose-500/10 text-rose-300', icon: '⚡' },
  interrupt: { chip: 'bg-orange-500/10 text-orange-300', icon: '⏸' }
}

/** channel 运行时看板：读取 ~/.trellis/channels 的事件日志，可直接向频道发消息驱动 AI worker。 */
export function ChannelPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const settings = useApp((s) => s.settings)
  const pushToast = useApp((s) => s.pushToast)
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventsEndRef = useRef<HTMLDivElement>(null)

  const ownBucket = snapshot.meta.root.replace(/[:\\/]/g, '-')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const res = await api.channelList()
    setLoading(false)
    if (res.ok && res.channels) {
      setChannels(res.channels)
      setError(res.channels.length === 0 ? '暂无 channel — 用 `trellis channel create <名字>` 创建多智能体协作频道' : null)
      setSelected((cur) => {
        if (cur && res.channels?.some((c) => `${c.bucket}/${c.name}` === cur)) return cur
        const own = res.channels?.find((c) => c.bucket === ownBucket)
        return own ? `${own.bucket}/${own.name}` : res.channels?.[0] ? `${res.channels[0].bucket}/${res.channels[0].name}` : null
      })
    } else {
      setError(res.error ?? '读取失败')
    }
  }, [ownBucket])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000) // live tail
    return () => clearInterval(t)
  }, [load])

  const current = channels.find((c) => `${c.bucket}/${c.name}` === selected)

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [current?.events.length])

  const send = async (): Promise<void> => {
    if (!current || !input.trim()) return
    setSending(true)
    const res = await api.channelSend(current.name, input.trim())
    setSending(false)
    if (res.ok) {
      pushToast({ kind: 'success', title: `已发送到 #${current.name}`, body: '频道内的 AI worker 会收到该消息' })
      setInput('')
      setTimeout(() => void load(), 800)
    } else {
      pushToast({ kind: 'error', title: `发送失败`, body: res.error })
    }
  }

  const isOwn = (c: ChannelSummary): boolean => c.bucket === ownBucket

  return (
    <div className="flex h-full animate-fade-in">
      {/* channel list */}
      <div className="w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850/40 p-2.5">
        <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist-500">
          <Radio size={12} /> Channels
          <button onClick={() => void load()} className="ml-auto text-mist-600 hover:text-mist-300" title="刷新">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {error && <div className="px-1 py-3 text-[11px] leading-4 text-mist-500">{error}</div>}
        {channels.map((c) => (
          <button
            key={`${c.bucket}/${c.name}`}
            onClick={() => setSelected(`${c.bucket}/${c.name}`)}
            className={clsx(
              'mb-1 w-full rounded-lg px-2.5 py-2 text-left transition-colors',
              selected === `${c.bucket}/${c.name}` ? 'bg-leaf-dim/15' : 'hover:bg-ink-700/40'
            )}
          >
            <div className="flex items-center gap-1.5">
              <Hash size={11} className="shrink-0 text-mist-500" />
              <span className={clsx('min-w-0 flex-1 truncate text-xs font-medium', selected === `${c.bucket}/${c.name}` ? 'text-leaf-soft' : 'text-mist-200')}>
                {c.name}
              </span>
              {isOwn(c) && <span className="chip bg-leaf/10 text-[9px] text-leaf-soft">本项目</span>}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-[10px] text-mist-500">
              <span>{c.eventCount} 事件</span>
              <span>·</span>
              <span>{c.participants.join(' / ')}</span>
            </div>
          </button>
        ))}
      </div>

      {/* events + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
              <Hash size={14} className="text-leaf" />
              <span className="text-sm font-semibold text-mist-50">{current.name}</span>
              <span className="chip bg-ink-750 text-mist-400">{current.type}</span>
              <span className="text-[11px] text-mist-500">
                <Users size={10} className="mr-0.5 inline" />
                {current.participants.join(' / ')}
              </span>
              {!isOwn(current) && <span className="chip bg-ink-750 text-mist-500">外部项目频道</span>}
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
              {current.events.map((e, i) => {
                const st = KIND_STYLE[e.kind] ?? { chip: 'bg-ink-700 text-mist-300', icon: '·' }
                return (
                  <div key={`${e.seq}-${i}`} className="flex items-start gap-2.5 text-xs">
                    <span className={clsx('chip mt-0.5 shrink-0 font-mono', st.chip)}>{e.kind}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-mist-300">{e.by}</span>
                        <span className="text-[10px] text-mist-600">{fmtIso(e.ts)}</span>
                        <span className="font-mono text-[9.5px] text-mist-700">#{e.seq}</span>
                      </div>
                      {e.text && <div className="mt-0.5 whitespace-pre-wrap break-words text-mist-200">{e.text}</div>}
                    </div>
                  </div>
                )
              })}
              <div ref={eventsEndRef} />
            </div>

            <div className="flex gap-2 border-t border-ink-700 bg-ink-850/60 px-4 py-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void send()}
                disabled={sending}
                placeholder={`向 #${current.name} 发送指令（频道内的 AI worker 会收到）…`}
                className="field flex-1"
              />
              <button onClick={() => void send()} disabled={sending || !input.trim()} className="btn-primary disabled:opacity-50">
                <Send size={12} /> {sending ? '发送中…' : '发送'}
              </button>
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-xs text-mist-500">
            {loading ? '读取频道中…' : '选择左侧频道查看实时事件'}
          </div>
        )}
      </div>
    </div>
  )
}
