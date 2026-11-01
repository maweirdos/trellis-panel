import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, Check, Info, RefreshCw, X } from 'lucide-react'
import { Select } from '../../components/Select'
import { ToolBrandIcon } from '../../components/ToolBrandIcon'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { relTime } from '../../utils/format'
import { errorText } from '../../../../shared/errors'
import { taskConversationSourceSchema, type ExternalConversation, type TaskConversationCandidates, type TaskConversationPreview, type TaskConversationSource } from '../../../../shared/task-conversations'
import { Button, Modal, SearchInput } from '../ui'
import { TASK_CONVERSATION_SOURCE_LABELS, taskConversationDirectory, type TaskConversationController } from '../use-task-conversations'
import { TaskConversationEntry } from './TaskConversationEntry'

function capabilityLabel(conversation: ExternalConversation): string | null {
  const destination = conversation.destinationLabel
  const distinctDestination = destination && destination.trim().toLocaleLowerCase() !== TASK_CONVERSATION_SOURCE_LABELS[conversation.source].toLocaleLowerCase() ? destination : null
  if (conversation.capability === 'unavailable') return ['不可用', distinctDestination].filter(Boolean).join(' · ')
  return distinctDestination || (conversation.capability === 'workspace' ? '打开工作区' : destination ? null : '恢复会话')
}

export function TaskConversationAssociationModal({ taskDir, taskTitle, controller, onClose }: {
  taskDir: string
  taskTitle: string
  controller: TaskConversationController
  onClose: () => void
}): JSX.Element {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const mounted = useRef(false)
  const sequence = useRef(0)
  const [candidates, setCandidates] = useState<TaskConversationCandidates | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<TaskConversationSource | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [previewState, setPreviewState] = useState<{ id: string; loading: boolean; value?: TaskConversationPreview; error?: string } | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const previewSequence = useRef(0)
  const { discover, preview } = controller
  const busy = controller.pendingTaskDir !== null
  const bindings = controller.bindingsFor(taskDir)
  const load = useCallback(async (): Promise<void> => {
    if (!canInteract()) return
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    setSelected(null)
    setShowFeedback(false)
    try {
      const result = await discover()
      if (!mounted.current || !canInteract() || request !== sequence.current) return
      if (result) {
        setCandidates(result)
        setSelected((previous) => result.items.some((item) => item.id === previous) ? previous : null)
      }
    } catch (cause) {
      if (mounted.current && canInteract() && request === sequence.current) setError(errorText(cause, '发现原生会话失败。'))
    } finally {
      if (mounted.current && canInteract() && request === sequence.current) setLoading(false)
    }
  }, [discover, canInteract])

  useEffect(() => {
    mounted.current = true
    if (active) void load()
    return () => { mounted.current = false; sequence.current++ }
  }, [active, load])

  useEffect(() => {
    const request = ++previewSequence.current
    if (!selected || !active || !canInteract()) { setPreviewState(null); return }
    setPreviewState({ id: selected, loading: true })
    void preview(taskDir, selected).then((value) => {
      if (!mounted.current || !canInteract() || request !== previewSequence.current) return
      setPreviewState(value ? { id: selected, loading: false, value } : null)
    }).catch((cause) => {
      if (mounted.current && canInteract() && request === previewSequence.current) setPreviewState({ id: selected, loading: false, error: errorText(cause, '此来源暂时无法读取会话片段。') })
    })
    return () => { previewSequence.current++ }
  }, [selected, active, taskDir, preview, canInteract])

  const attach = async (): Promise<void> => {
    if (!selected || busy || !canInteract()) return
    const linked = await controller.bind(taskDir, selected)
    if (linked && mounted.current && canInteract()) onClose()
  }
  const needle = query.trim().toLocaleLowerCase()
  const titleCounts = new Map<string, number>()
  for (const item of candidates?.items ?? []) {
    const key = JSON.stringify([item.source, item.title])
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }
  const items = candidates?.items.filter((item) => (source === 'all' || item.source === source)
    && (!needle || [item.title, item.sessionId, TASK_CONVERSATION_SOURCE_LABELS[item.source]].some((value) => value.toLocaleLowerCase().includes(needle)))) ?? []
  const sources = candidates?.sources ?? controller.data?.sources ?? []
  const selectedItem = candidates?.items.find((item) => item.id === selected)
  const alreadyLinked = Boolean(selectedItem && bindings.some((binding) => binding.conversation.id === selectedItem.id))
  const root = controller.data?.projectRoot ?? ''
  const feedback = showFeedback && controller.feedback?.taskDir && taskConversationDirectory(root, controller.feedback.taskDir) === taskConversationDirectory(root, taskDir) ? controller.feedback : null
  const selectedPreview = previewState?.id === selected ? previewState : null

  return <Modal open={active} onClose={onClose} width={640} ariaLabel="修复任务执行入口">
    <div className="my-modal-content my-task-conversation-association">
      <header className="my-task-conversation-association__header">
        <div className="min-w-0"><h2 className="text-my-lg font-semibold text-my-primary">修复执行入口</h2><p className="my-task-conversation-association__task">{taskTitle}</p></div>
        <Button variant="ghost" size="sm" aria-label="关闭执行入口修复" onClick={onClose}><X size={16} /></Button>
      </header>
      {bindings.length > 0 && <section aria-label="已关联会话" className="my-task-conversation-association__section">
        <h3 className="text-my-xs font-medium text-my-secondary">当前执行入口</h3>
        <ul className="my-task-conversation-association__bindings">{bindings.map((binding) => <li key={binding.id}>
          <TaskConversationEntry title={binding.conversation.title} source={binding.conversation.source} sourceLabel={TASK_CONVERSATION_SOURCE_LABELS[binding.conversation.source]}
            capability={binding.conversation.capability} destinationLabel={binding.conversation.destinationLabel} unavailableReason={binding.conversation.unavailableReason}
            actionDescription="仅打开原生历史核对，不复制接续说明。"
            disabled={busy || binding.conversation.capability === 'unavailable'} onOpen={() => { setShowFeedback(true); void controller.open(taskDir, binding.id) }} />
          <div className="my-task-conversation-association__actions">
            {binding.primary ? <span className="my-task-conversation-association__primary"><Check size={12} />主会话</span>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setMessage(null); setShowFeedback(true); void controller.setPrimary(taskDir, binding.id) }}>设为主会话</Button>}
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`解除关联：${binding.conversation.title}`} onClick={() => { setMessage(null); setShowFeedback(true); void controller.unbind(taskDir, binding.id) }}>解除</Button>
          </div>
        </li>)}</ul>
      </section>}
      <div className="my-task-conversation-association__filters">
        <SearchInput value={query} onChange={(value) => { setQuery(value); setSelected(null) }} placeholder="筛选会话标题或原生 ID…" ariaLabel="筛选当前项目的原生会话" size="sm" className="flex-1 min-w-0" />
        <Select<TaskConversationSource | 'all'> value={source} onChange={(value) => { setSource(value); setSelected(null) }} ariaLabel="会话来源" size="sm"
          options={[{ value: 'all', label: '全部来源' }, ...taskConversationSourceSchema.options.map((value) => ({ value, label: TASK_CONVERSATION_SOURCE_LABELS[value], icon: <ToolBrandIcon brand={value} size={16} /> }))]} />
        <Button variant="ghost" size="sm" disabled={loading || busy} aria-label="重新发现原生会话" onClick={() => { void load() }}><RefreshCw size={14} /></Button>
      </div>
      <div className="my-task-conversation-association__candidates my-scrollbar" aria-busy={loading}>
        {loading && <p className="my-task-conversation-association__notice" role="status">读取当前项目的原生会话…</p>}
        {!loading && error && <p className="my-task-conversation-association__notice text-my-danger-text" role="alert"><Info size={14} />{error}</p>}
        {!loading && !error && items.length === 0 && <p className="my-task-conversation-association__notice" role="status">{needle || source !== 'all' ? '没有符合筛选条件的会话。' : '未发现当前项目的原生会话。'}</p>}
        {!loading && !error && <ul>{items.map((item) => {
          const metadata = [TASK_CONVERSATION_SOURCE_LABELS[item.source], capabilityLabel(item)].filter(Boolean).join(' · ')
          const linked = bindings.some((binding) => binding.conversation.id === item.id)
          const date = Number.isFinite(item.updatedAt) && item.updatedAt > 0 ? new Date(item.updatedAt) : null
          const updated = date && Number.isFinite(date.getTime()) ? date : null
          const updatedLabel = updated ? relTime(item.updatedAt) : '时间未记录'
          const duplicateTitle = (titleCounts.get(JSON.stringify([item.source, item.title])) ?? 0) > 1
          const shortId = item.sessionId.length > 16 ? `${item.sessionId.slice(0, 6)}…${item.sessionId.slice(-6)}` : item.sessionId
          return <li key={item.id}><button type="button" className="my-task-conversation-candidate" aria-pressed={selected === item.id}
            title={`${item.title}\n原生 ID：${item.sessionId}`} aria-label={`${item.title} · ${metadata} · ${updatedLabel} · 原生 ID：${item.sessionId}`}
            disabled={busy} onClick={() => { setSelected(item.id); setMessage(null); setShowFeedback(false) }}>
            <ToolBrandIcon brand={item.source} size={16} />
            <span className="my-task-conversation-candidate__content"><span className="my-task-conversation-candidate__title">{item.title}</span>
              <span className="my-task-conversation-candidate__meta">{metadata}{item.titleSource === 'fallback' ? ' · 原生 ID' : item.titleSource === 'summary' ? ' · 摘要标题' : ''}
                {' · '}{updated ? <time dateTime={updated.toISOString()} title={`最后更新：${updated.toLocaleString('zh-CN')}`}>{updatedLabel}</time> : <span>{updatedLabel}</span>}
                {duplicateTitle && <> · <span title={item.sessionId}>ID {shortId}</span></>}
              </span>
              {item.unavailableReason && <span className="my-task-conversation-candidate__meta my-task-conversation-candidate__reason">{item.unavailableReason}</span>}
            </span>
            {linked ? <span className="my-task-conversation-candidate__linked">已关联</span> : selected === item.id ? <Check size={14} aria-hidden="true" /> : null}
          </button></li>
        })}</ul>}
      </div>
      {selectedItem && <section aria-label="所选原生会话片段" className="my-task-conversation-preview">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-my-sm font-medium text-my-primary">最近会话片段（只读）</h3>
          <Button variant="neutral" size="sm" disabled={busy || selectedItem.capability === 'unavailable'} onClick={() => { setShowFeedback(true); void controller.inspect(taskDir, selectedItem.id) }}><ArrowUpRight size={14} />{selectedItem.capability === 'workspace' ? '打开工作区核对' : '打开原生会话核对'}</Button>
        </header>
        {selectedItem.capability === 'unavailable' && <p className="text-my-xs text-my-secondary">{selectedItem.unavailableReason ?? '原生导航暂不可用。'}</p>}
        {selectedPreview?.loading && <p role="status" className="text-my-sm text-my-secondary">读取会话片段…</p>}
        {(selectedPreview?.error || selectedPreview?.value?.unavailableReason) && <p role="alert" className="text-my-sm text-my-danger-text">{selectedPreview.error ?? selectedPreview.value?.unavailableReason}</p>}
        {selectedPreview?.value && <>
          {selectedPreview.value.messages.length === 0 && !selectedPreview.value.unavailableReason && <p className="text-my-sm text-my-secondary">没有可预览的用户或助手消息。</p>}
          <ol className="my-task-conversation-preview__messages my-scrollbar">{selectedPreview.value.messages.map((item, index) => <li key={index}><span className="text-my-xs text-my-tertiary">{item.role === 'user' ? '用户' : '助手'}</span><p>{item.text}</p></li>)}</ol>
          {selectedPreview.value.truncated && <p className="text-my-xs text-my-secondary">仅展示可读取的部分最近对话。</p>}
        </>}
      </section>}
      {candidates?.truncated && <p className="text-my-xs text-my-secondary">本次扫描结果已截断。</p>}
      {sources.length > 0 && <details className="my-task-conversation-association__sources"><summary>原生来源读取状态</summary><ul>{sources.map((item) => <li key={item.source}>{TASK_CONVERSATION_SOURCE_LABELS[item.source]} · {item.available ? '读取可用' : '暂不可用'}{item.detail ? ` · ${item.detail}` : ''}</li>)}</ul></details>}
      {(feedback || message) && <p className={feedback?.error ? 'text-my-xs text-my-danger-text' : 'text-my-xs text-my-secondary'} role={feedback?.error ? 'alert' : 'status'}>{feedback?.message ?? message}</p>}
      <footer className="my-task-conversation-association__footer">
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        <Button variant="primary" size="sm" disabled={!selected || alreadyLinked || busy || loading || selectedPreview?.loading || !selectedPreview?.value} onClick={() => { setShowFeedback(true); void attach() }}>{busy ? '处理中…' : '保存执行入口'}</Button>
      </footer>
    </div>
  </Modal>
}
