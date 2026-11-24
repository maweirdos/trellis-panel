import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import type { ConversationThreadSnapshot } from '../../../shared/conversation/command-runtime'
import type { OrchestrationV2AppThread } from '../../../shared/conversation/contracts'
import { ConversationListRow } from '../acp/ConversationListRow'
import { api, hasIpc } from '../api'
import { MarkdownView } from '../components/MarkdownView'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, Modal, SearchInput } from '../my/ui'
import { useApp } from '../store'
import { useInteractionActive } from '../utils/interaction-scope'
import '../acp/workspace.css'

export function ConversationArchiveManager({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element | null {
  const interactive = useInteractionActive()
  const codeRoot = useApp(state => state.snapshot?.meta.root)
  const [workRoot, setWorkRoot] = useState<string>()
  const [mode, setMode] = useState<'work' | 'code'>('work')
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<readonly OrchestrationV2AppThread[]>()
  const [selected, setSelected] = useState<{ root: string; threadId: string }>()
  const [snapshot, setSnapshot] = useState<ConversationThreadSnapshot>()
  const [revision, setRevision] = useState(0)
  const [issue, setIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const [readingEarlier, setReadingEarlier] = useState(false)
  const root = mode === 'code' ? codeRoot : workRoot
  const scope = useRef({ open, interactive, root, selected })
  scope.current = { open, interactive, root, selected }
  const pending = useRef<{ root: string; threadId: string; commandId: string }>()
  const historyRead = useRef<symbol>()

  useEffect(() => {
    if (!open || !interactive || !hasIpc) return
    let current = true
    void api.conversationWorkRoot().then(result => {
      if (!current) return
      if (result.ok) setWorkRoot(result.root)
      else setIssue(result.error)
    }).catch(() => { if (current) setIssue('无法打开 Work 会话目录。') })
    return () => { current = false }
  }, [open, interactive])

  useEffect(() => {
    if (!open || !interactive || !root || !hasIpc) return
    let current = true
    setThreads(undefined)
    void api.conversationList(root, { archived: true, query }).then(result => {
      if (!current) return
      if (result.ok) { setThreads(result.threads); setIssue('') }
      else setIssue(result.error)
    }).catch(() => { if (current) setIssue('无法读取归档会话。') })
    return () => { current = false }
  }, [open, interactive, root, query, revision])

  useEffect(() => {
    if (!open || !interactive || !root || selected?.root !== root) return
    let current = true
    setSnapshot(undefined)
    void api.conversationRead(selected.threadId, root).then(result => {
      if (!current) return
      if (result.ok) { setSnapshot(result); setIssue('') }
      else setIssue(result.error)
    }).catch(() => { if (current) setIssue('无法读取原会话。') })
    return () => { current = false }
  }, [open, interactive, root, selected])

  async function loadEarlier(): Promise<void> {
    if (!open || !interactive || !root || !selected || !snapshot?.historyCursor || historyRead.current) return
    const { threadId } = selected
    const cursor = snapshot.historyCursor
    const request = Symbol()
    historyRead.current = request
    setReadingEarlier(true)
    const isCurrent = (): boolean => scope.current.open && scope.current.interactive
      && scope.current.root === root && scope.current.selected === selected
    try {
      const result = await api.conversationHistory({ cwd: root, threadId, cursor, limit: 32 })
      if (!isCurrent()) return
      if (!result.ok) {
        setIssue(result.error)
        return
      }
      setSnapshot(current => {
        if (!current || current.thread.id !== threadId || current.historyCursor !== cursor) return current
        const known = new Set(current.messages.map(message => message.id))
        return { ...current, historyCursor: result.page.historyCursor,
          messages: [...result.page.messages.filter(message => !known.has(message.id)), ...current.messages] }
      })
      setIssue('')
    } catch {
      if (isCurrent()) setIssue('无法读取更早的消息。')
    } finally {
      if (historyRead.current === request) {
        historyRead.current = undefined
        setReadingEarlier(false)
      }
    }
  }

  async function restore(threadId: string): Promise<void> {
    if (!root || !interactive || busy || pending.current && (pending.current.root !== root || pending.current.threadId !== threadId)) return
    const original = pending.current
    const commandId = original?.commandId ?? crypto.randomUUID()
    if (!original) pending.current = { root, threadId, commandId }
    setBusy(true)
    setIssue('')
    try {
      const result = original
        ? await api.conversationThreadCommand({ cwd: root, threadId, commandId })
        : await api.conversationApply({ cwd: root, command: { type: 'thread.archive', threadId, commandId, archived: false } })
      if (!scope.current.open || !scope.current.interactive || scope.current.root !== root) return
      if (result.ok && result.receipt) {
        pending.current = undefined
        setSelected(undefined)
        setRevision(value => value + 1)
      } else if (!result.ok) {
        if (!original && 'outcome' in result && result.outcome === 'not-admitted') pending.current = undefined
        setIssue(result.error)
      } else setIssue('原恢复操作尚无可核对的回执。')
    } catch {
      if (scope.current.open && scope.current.root === root) setIssue('恢复结果待核对。')
    } finally { setBusy(false) }
  }

  if (!open) return null
  const reading = Boolean(selected && selected.root === root)
  const waiting = pending.current?.root === root ? pending.current : undefined
  return <Modal open={open} onClose={onClose} ariaLabel="归档会话" width={760}>
    <section className="space-y-3 p-4">
      <header className="flex items-center gap-2">
        {reading && <Button variant="ghost" size="sm" aria-label="返回归档列表" onClick={() => setSelected(undefined)}><ArrowLeft size={16} /></Button>}
        <h2 className="flex-1 text-my-lg font-medium">{reading ? snapshot?.thread.title ?? '归档会话' : '归档会话'}</h2>
        {reading && selected && <Button variant="neutral" size="sm" disabled={busy || Boolean(waiting && waiting.threadId !== selected.threadId)}
          onClick={() => void restore(selected.threadId)}>{waiting ? '查询恢复回执' : '恢复会话'}</Button>}
        <Button variant="ghost" size="sm" aria-label="关闭归档" onClick={onClose}><X size={16} /></Button>
      </header>
      {!reading && <div className="flex flex-wrap items-center gap-2">
        <div className="my-segmented" aria-label="会话目录">
          <button type="button" className="my-segment" aria-pressed={mode === 'work'} onClick={() => setMode('work')}>Work</button>
          <button type="button" className="my-segment" aria-pressed={mode === 'code'} disabled={!codeRoot} onClick={() => setMode('code')}>Code</button>
        </div>
        <SearchInput value={query} onChange={value => setQuery(value.slice(0, 160))} size="sm" placeholder="搜索归档" />
      </div>}
      {issue && <FeedbackNotice variant="inline" title={waiting ? '恢复结果待核对' : '无法读取归档会话'} diagnostic={issue}
        actions={waiting && !reading && <Button variant="ghost" size="sm" onClick={() => void restore(waiting.threadId)}>查询回执</Button>} />}
      <div className="my-scrollbar max-h-[55vh] overflow-y-auto" aria-busy={reading ? !snapshot && !issue : !threads && !issue}>
        {reading ? <>
          {snapshot?.historyCursor && <Button size="sm" variant="ghost" disabled={readingEarlier}
            onClick={() => void loadEarlier()}>{readingEarlier ? '正在读取…' : '读取更早的消息'}</Button>}
          {snapshot?.messages.map(message => <article key={message.id} className="my-chat-prose py-2" aria-label={message.role === 'user' ? '你的消息' : '会话回复'}>
          <MarkdownView content={message.text} />
          </article>)}
        </> : <>
          {threads?.length === 0 && <p className="my-item-description py-3">{query ? '没有匹配的归档会话' : '暂无归档会话'}</p>}
          {threads?.map(thread => <ConversationListRow key={thread.id} id={thread.id} title={thread.title} selected={false} archived
            onSelect={() => { if (root) setSelected({ root, threadId: thread.id }) }}
            onToggleArchive={!waiting || waiting.threadId === thread.id ? () => void restore(thread.id) : undefined} />)}
        </>}
      </div>
    </section>
  </Modal>
}
