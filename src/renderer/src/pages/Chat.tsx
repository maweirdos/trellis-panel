import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useApp } from '../store'
import { api } from '../api'
import { useChatEntries } from '../chat/useChatEntries'
import { useTranscriptScroll, useTranscriptWindow } from '../chat/useTranscriptScroll'
import { MarkdownView } from '../components/MarkdownView'
import { clsx } from 'clsx'
import {
  Plus,
  Trash2,
  Send,
  Square,
  Check,
  Copy,
  ChevronDown,
  Bot,
  Hourglass,
  Download,
  Brain,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Pencil
} from 'lucide-react'
import type { ModelProvider, ThinkingLevel } from '../../../shared/types'

/**
 * AI 对话页：左会话列表 / 中转录（Entry 管道 + 滚动状态机）/ 下 Composer。
 * 模型按会话绑定（provider+model 随 chat:send 持久化到会话记录）。
 */

function ComposerModelPicker(): { provider: ModelProvider | null; modelId: string; picker: JSX.Element } {
  const settings = useApp((s) => s.settings)
  const providers = useMemo(() => (settings?.ai?.providers ?? []).filter((p) => p.enabled), [settings])
  const [providerId, setProviderId] = useState<string>('')
  const [modelId, setModelId] = useState<string>('')

  useEffect(() => {
    if (providers.length === 0) return
    if (!providers.some((p) => p.id === providerId)) {
      setProviderId(providers[0].id)
      setModelId(providers[0].models?.find((m) => m.enabled)?.id ?? providers[0].models?.[0]?.id ?? '')
    }
  }, [providers, providerId])

  const provider = providers.find((p) => p.id === providerId) ?? null

  const picker = (
    <div className="flex items-center gap-1">
      <select
        value={providerId}
        onChange={(e) => {
          const p = providers.find((x) => x.id === e.target.value)
          setProviderId(e.target.value)
          setModelId(p?.models?.find((m) => m.enabled)?.id ?? p?.models?.[0]?.id ?? '')
        }}
        className="max-w-[130px] rounded-md border border-ink-600 bg-ink-850 px-1.5 py-1 text-[11px] text-mist-300 outline-none focus:border-leaf/60"
        title="供应商"
      >
        {providers.length === 0 && <option value="">未配置供应商</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        value={modelId}
        onChange={(e) => setModelId(e.target.value)}
        className="max-w-[170px] rounded-md border border-ink-600 bg-ink-850 px-1.5 py-1 text-[11px] text-mist-300 outline-none focus:border-leaf/60"
        title="模型"
      >
        {(!provider || provider.models.length === 0) && <option value="">未选择模型</option>}
        {provider?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
      </select>
    </div>
  )

  return { provider, modelId, picker }
}

/** 分支切换器：同一位置存在多个兄弟版本时显示 ‹ i/n › */
function BranchSwitcher({
  index,
  count,
  ids,
  onSwitch
}: {
  index: number
  count: number
  ids: string[]
  onSwitch: (id: string) => void
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-ink-600/70 bg-ink-850/60 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">
      <button
        disabled={index <= 0}
        onClick={() => ids[index - 1] && onSwitch(ids[index - 1])}
        className="disabled:opacity-30 hover:text-mist-200"
        title="上一分支"
      >
        <ChevronLeft size={10} />
      </button>
      {index + 1}/{count}
      <button
        disabled={index >= count - 1}
        onClick={() => ids[index + 1] && onSwitch(ids[index + 1])}
        className="disabled:opacity-30 hover:text-mist-200"
        title="下一分支"
      >
        <ChevronRight size={10} />
      </button>
    </span>
  )
}

const THINKING_LABEL: Record<ThinkingLevel, string> = { off: '关', low: '低', medium: '中', high: '高' }
const THINKING_VALUES: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** 思考流折叠条目（TPD-014）：默认收起，流式时展开并实时增长 */
function ThinkingBlock({ reasoning, live }: { reasoning: string; live?: boolean }): JSX.Element {
  const [open, setOpen] = useState(!!live)
  useEffect(() => {
    if (live) setOpen(true)
  }, [live])
  return (
    <div className="mb-2 rounded-lg border border-violet-400/25 bg-violet-500/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-violet-300/90"
      >
        <Brain size={11} />
        {live ? '思考中…' : '思考过程'}
        <span className="text-violet-300/50">（{reasoning.length} 字）</span>
        <span className="flex-1" />
        <ChevronRight size={11} className={clsx('transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words border-t border-violet-400/15 px-3 py-2 text-[11px] leading-5 text-violet-200/70">
          {reasoning}
        </p>
      )}
    </div>
  )
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        void api.copyToClipboard(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="shrink-0 rounded p-1 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-mist-200"
      title="复制"
    >
      {done ? <Check size={12} className="text-leaf" /> : <Copy size={12} />}
    </button>
  )
}

export function ChatPage(): JSX.Element {
  const sessions = useApp((s) => s.chatSessions)
  const activeId = useApp((s) => s.chatActiveId)
  const messages = useApp((s) => s.chatMessages)
  const streaming = useApp((s) => s.chatStreaming)
  const pending = useApp((s) => s.chatPending)
  const chatAttachEvents = useApp((s) => s.chatAttachEvents)
  const chatLoadSessions = useApp((s) => s.chatLoadSessions)
  const chatOpenSession = useApp((s) => s.chatOpenSession)
  const chatNewSession = useApp((s) => s.chatNewSession)
  const chatDeleteSession = useApp((s) => s.chatDeleteSession)
  const chatSend = useApp((s) => s.chatSend)
  const chatAbort = useApp((s) => s.chatAbort)
  const chatRegenerate = useApp((s) => s.chatRegenerate)
  const chatEditResend = useApp((s) => s.chatEditResend)
  const chatBranch = useApp((s) => s.chatBranch)
  const aiEnabled = useApp((s) => !!s.settings?.ai?.enabled)

  const [draft, setDraft] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('off')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const { provider, modelId, picker } = ComposerModelPicker()

  // 切换会话时同步该会话的思考档位
  useEffect(() => {
    const meta = sessions.find((x) => x.id === activeId)
    if (meta?.thinkingLevel) setThinkingLevel(meta.thinkingLevel)
  }, [activeId, sessions])

  useEffect(() => chatAttachEvents(), [chatAttachEvents])

  useEffect(() => {
    void chatLoadSessions().then(() => {
      const st = useApp.getState()
      if (st.chatSessions[0] && !st.chatActiveId) void st.chatOpenSession(st.chatSessions[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const entries = useChatEntries(messages)
  const streamLength = streaming?.content.length ?? 0
  const { containerRef, atBottom, scrollToBottom } = useTranscriptScroll(entries.length * 1000 + streamLength + pending.length)
  const { visibleCount, showOlder, hasOlder, hiddenCount } = useTranscriptWindow(entries.length, activeId ?? '')
  const visible = hasOlder ? entries.slice(entries.length - visibleCount) : entries

  // 内容增长时跟随滚动（hook 仅对 entries 数量变化生效，流式增量在此补齐）
  useEffect(() => {
    if (atBottom) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamLength, visible.length, pending.length])

  const submit = (): void => {
    const text = draft.trim()
    if (!text || streaming) return
    setDraft('')
    void chatSend(text, { providerId: provider?.id, modelId, thinkingLevel })
  }

  const queueMore = (): void => {
    const text = draft.trim()
    if (!text || !streaming) return
    setDraft('')
    void chatSend(text, { providerId: provider?.id, modelId, thinkingLevel })
  }

  const regenerate = (): void => {
    if (busy) return
    void chatRegenerate()
  }

  const exportMarkdown = (): void => {
    const session = sessions.find((s) => s.id === activeId)
    const lines = [`# ${session?.title ?? '对话'}`, '']
    for (const e of entries) {
      lines.push(e.kind === 'user' ? `## 🧑 提问\n\n${e.content}` : `## 🤖 回答\n\n${e.content}`)
    }
    const blob = new Blob([lines.join('\n\n')], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${session?.title ?? 'chat'}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const busy = !!streaming
  const activeSession = sessions.find((s) => s.id === activeId)

  return (
    <div className="flex h-full">
      {/* 会话列表 */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-ink-700/70 bg-ink-950/40">
        <div className="flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-mist-200">
          <Bot size={13} /> AI 对话
          <span className="flex-1" />
          <button
            onClick={() => void chatNewSession({ providerId: provider?.id, modelId })}
            className="btn-ghost p-1"
            title="新建会话"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 && (
            <p className="px-2 py-4 text-[11px] leading-5 text-mist-500">还没有会话。点击 + 新建，或直接在下方输入第一条消息。</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={clsx(
                'group mb-0.5 flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
                s.id === activeId ? 'bg-leaf/10 text-mist-100' : 'text-mist-400 hover:bg-ink-800/60'
              )}
              onClick={() => void chatOpenSession(s.id)}
            >
              <span className="min-w-0 flex-1 truncate" title={s.title}>
                {s.title}
              </span>
              <span className="shrink-0 font-mono text-[9.5px] text-mist-600">{s.messageCount}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void chatDeleteSession(s.id)
                }}
                className="shrink-0 rounded p-0.5 text-mist-600 opacity-0 hover:text-rose-300 group-hover:opacity-100"
                title="删除会话"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 转录 + Composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-ink-700/60 px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-mist-200">{activeSession?.title ?? '新对话'}</span>
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            className="rounded-md border border-ink-600 bg-ink-850 px-1.5 py-1 text-[11px] text-mist-300 outline-none focus:border-leaf/60"
            title="思考档位（按供应商协议映射；reasoning 模型的思考流独立折叠展示）"
          >
            {THINKING_VALUES.map((v) => (
              <option key={v} value={v}>
                思考: {THINKING_LABEL[v]}
              </option>
            ))}
          </select>
          {picker}
          <button onClick={exportMarkdown} className="btn-ghost p-1" title="导出 Markdown" disabled={entries.length === 0}>
            <Download size={13} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-3 px-4 py-4">
              {hasOlder && (
                <div className="text-center">
                  <button onClick={showOlder} className="btn-ghost text-[11px]">
                    加载更早的消息（还有 {hiddenCount} 条）
                  </button>
                </div>
              )}
              {visible.length === 0 && !streaming && pending.length === 0 && (
                <div className="py-16 text-center text-xs text-mist-500">
                  开始你的第一条对话。模型按会话绑定，可随时在上方切换。
                </div>
              )}
              {visible.map((e, idx) => {
                if (e.kind === 'user') {
                  const isEditing = editing?.id === e.key
                  return (
                    <div key={e.key} className="group flex flex-col items-end gap-1">
                      {isEditing ? (
                        <div className="flex w-[80%] flex-col gap-1.5">
                          <textarea
                            value={editing.text}
                            onChange={(ev) => setEditing({ id: e.key, text: ev.target.value })}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
                                ev.preventDefault()
                                const text = editing.text.trim()
                                if (text && e.id) void chatEditResend(e.id, text)
                                setEditing(null)
                              } else if (ev.key === 'Escape') {
                                setEditing(null)
                              }
                            }}
                            rows={Math.min(6, Math.max(2, editing.text.split('\n').length))}
                            className="resize-none rounded-lg border border-leaf/50 bg-ink-850 px-3 py-2 text-xs text-mist-200 outline-none"
                            autoFocus
                          />
                          <div className="flex justify-end gap-1.5 text-[11px]">
                            <button onClick={() => setEditing(null)} className="btn-ghost">取消（Esc）</button>
                            <button
                              onClick={() => {
                                const text = editing.text.trim()
                                if (text && e.id) void chatEditResend(e.id, text)
                                setEditing(null)
                              }}
                              className="btn-primary"
                            >
                              保存并重发
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex max-w-[80%] items-end gap-1">
                          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-leaf/15 px-3.5 py-2 text-xs leading-relaxed text-mist-100">
                            {e.content}
                          </div>
                          {e.id && (
                            <button
                              onClick={() => setEditing({ id: e.key, text: e.content })}
                              className="shrink-0 rounded p-1 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-mist-200"
                              title="编辑并重发（生成新分支）"
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </div>
                      )}
                      {(e.siblingCount ?? 0) > 1 && e.siblingIds && (
                        <BranchSwitcher
                          index={e.siblingIndex ?? 0}
                          count={e.siblingCount ?? 0}
                          ids={e.siblingIds}
                          onSwitch={(id) => void chatBranch(id)}
                        />
                      )}
                    </div>
                  )
                }
                return (
                  <div key={e.key} className="group flex items-start gap-2">
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-ink-700/70 bg-ink-850/70 px-3.5 py-2.5">
                      {e.reasoning && <ThinkingBlock reasoning={e.reasoning} />}
                      <MarkdownView content={e.content} />
                      {(e.siblingCount ?? 0) > 1 && e.siblingIds && (
                        <div className="mt-2 border-t border-ink-700/60 pt-1.5">
                          <BranchSwitcher
                            index={e.siblingIndex ?? 0}
                            count={e.siblingCount ?? 0}
                            ids={e.siblingIds}
                            onSwitch={(id) => void chatBranch(id)}
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-0.5">
                      <CopyButton text={e.content} />
                      {idx === visible.length - 1 && (
                        <button
                          onClick={regenerate}
                          className="rounded p-1 text-mist-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-mist-200"
                          title="重新生成（保留旧回答为分支）"
                        >
                          <RefreshCw size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {pending.map((p) => (
                <div key={p.runId} className="flex justify-end">
                  <div className="flex max-w-[80%] items-center gap-1.5 rounded-2xl rounded-br-md border border-dashed border-ink-600 bg-ink-850/40 px-3.5 py-2 text-xs text-mist-400">
                    <Hourglass size={11} /> <span className="whitespace-pre-wrap">{p.content}</span>
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="rounded-2xl rounded-tl-md border border-leaf/20 bg-ink-850/70 px-3.5 py-2.5">
                  {streaming.reasoning && <ThinkingBlock reasoning={streaming.reasoning} live={!streaming.content} />}
                  {streaming.content ? (
                    <MarkdownView content={streaming.content} />
                  ) : (
                    !streaming.reasoning && <span className="inline-block h-3 w-1.5 animate-pulse bg-leaf" />
                  )}
                </div>
              )}
            </div>
          </div>
          {!atBottom && (
            <button
              onClick={() => scrollToBottom('smooth')}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-ink-600 bg-ink-850 px-3 py-1 text-[11px] text-mist-300 shadow-lg hover:border-leaf/50"
            >
              <ChevronDown size={11} /> 回到底部
            </button>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-ink-700/60 p-3">
          {!aiEnabled && (
            <p className="mb-2 text-[11px] text-amber-300/90">应用内 AI 未启用（设置 → AI 模型）。启用并配置供应商后即可对话。</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                } else if (e.key === 'Escape') {
                  setDraft('')
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行，Esc 清空"
              rows={Math.min(6, Math.max(1, draft.split('\n').length))}
              className="min-h-[38px] flex-1 resize-none rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-xs text-mist-200 outline-none placeholder:text-mist-600 focus:border-leaf/60"
            />
            {busy ? (
              <>
                <button
                  onClick={queueMore}
                  disabled={!draft.trim()}
                  className="btn-outline shrink-0 text-xs"
                  title="当前轮运行中，点击加入队列"
                >
                  <Hourglass size={12} /> 排队 ({pending.length})
                </button>
                <button
                  onClick={() => void chatAbort()}
                  className="btn shrink-0 bg-rose-500/15 text-xs text-rose-300 hover:bg-rose-500/25"
                  title="中止当前轮（Ctrl+.）"
                >
                  <Square size={12} /> 停止
                </button>
              </>
            ) : (
              <button onClick={submit} disabled={!draft.trim()} className="btn-primary shrink-0 text-xs">
                <Send size={12} /> 发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
