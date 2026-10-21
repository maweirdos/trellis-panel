import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Check, Info, RefreshCw, X } from 'lucide-react'
import { Select } from '../../components/Select'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import { relTime } from '../../utils/format'
import { errorText } from '../../../../shared/errors'
import { taskConversationSourceSchema, type ExternalConversation, type TaskConversationCandidates, type TaskConversationSource } from '../../../../shared/task-conversations'
import { Button, Modal, SearchInput } from '../ui'
import { TASK_CONVERSATION_SOURCE_LABELS, taskConversationDirectory, type TaskConversationController } from '../use-task-conversations'
import { TaskConversationEntry, TASK_CONVERSATION_SOURCE_ICONS } from './TaskConversationEntry'

function capabilityLabel(conversation: ExternalConversation): string {
  if (conversation.capability === 'unavailable') return ['不可用', conversation.destinationLabel].filter(Boolean).join(' · ')
  return conversation.destinationLabel || (conversation.capability === 'workspace' ? '打开工作区' : '恢复会话')
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
  const { discover } = controller
  const busy = controller.pendingTaskDir !== null
  const bindings = controller.bindingsFor(taskDir)
  const load = useCallback(async (): Promise<void> => {
    if (!canInteract()) return
    const request = ++sequence.current
    setLoading(true)
    setError(null)
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

  const attach = async (): Promise<void> => {
    if (!selected || busy || !canInteract()) return
    const linked = await controller.bind(taskDir, selected)
    if (linked && mounted.current && canInteract()) { setSelected(null); setMessage('已关联所选会话。') }
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
  const feedback = controller.feedback?.taskDir && taskConversationDirectory(root, controller.feedback.taskDir) === taskConversationDirectory(root, taskDir) ? controller.feedback : null

  return <Modal open={active} onClose={onClose} width={640} ariaLabel="关联与管理任务会话">
    <div className="my-modal-content my-task-conversation-association">
      <header className="my-task-conversation-association__header">
        <div className="min-w-0"><h2 className="text-my-lg font-semibold text-my-primary">关联会话</h2><p className="my-task-conversation-association__task">{taskTitle}</p></div>
        <Button variant="ghost" size="sm" aria-label="关闭关联会话" onClick={onClose}><X size={16} /></Button>
      </header>
      {bindings.length > 0 && <section aria-label="已关联会话" className="my-task-conversation-association__section">
        <h3 className="text-my-xs font-medium text-my-secondary">已关联</h3>
        <ul className="my-task-conversation-association__bindings">{bindings.map((binding) => <li key={binding.id}>
          <TaskConversationEntry title={binding.conversation.title} source={binding.conversation.source} sourceLabel={TASK_CONVERSATION_SOURCE_LABELS[binding.conversation.source]}
            capability={binding.conversation.capability} destinationLabel={binding.conversation.destinationLabel} unavailableReason={binding.conversation.unavailableReason}
            disabled={busy} onOpen={() => { void controller.open(taskDir, binding.id) }} />
          <div className="my-task-conversation-association__actions">
            {binding.primary ? <span className="my-task-conversation-association__primary"><Check size={12} />主会话</span>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setMessage(null); void controller.setPrimary(taskDir, binding.id) }}>设为主会话</Button>}
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`解除关联：${binding.conversation.title}`} onClick={() => { setMessage(null); void controller.unbind(taskDir, binding.id) }}>解除</Button>
          </div>
        </li>)}</ul>
      </section>}
      <div className="my-task-conversation-association__filters">
        <SearchInput value={query} onChange={(value) => { setQuery(value); setSelected(null) }} placeholder="筛选会话标题或原生 ID…" ariaLabel="筛选当前项目的原生会话" size="sm" className="flex-1 min-w-0" />
        <Select<TaskConversationSource | 'all'> value={source} onChange={(value) => { setSource(value); setSelected(null) }} ariaLabel="会话来源" size="sm"
          options={[{ value: 'all', label: '全部来源' }, ...taskConversationSourceSchema.options.map((value) => ({ value, label: TASK_CONVERSATION_SOURCE_LABELS[value] }))]} />
        <Button variant="ghost" size="sm" disabled={loading || busy} aria-label="重新发现原生会话" onClick={() => { void load() }}><RefreshCw size={14} /></Button>
      </div>
      <div className="my-task-conversation-association__candidates my-scrollbar" aria-busy={loading}>
        {loading && <p className="my-task-conversation-association__notice" role="status">读取当前项目的原生会话…</p>}
        {!loading && error && <p className="my-task-conversation-association__notice text-my-danger-text" role="alert"><Info size={14} />{error}</p>}
        {!loading && !error && items.length === 0 && <p className="my-task-conversation-association__notice" role="status">{needle || source !== 'all' ? '没有符合筛选条件的会话。' : '未发现当前项目的原生会话。'}</p>}
        {!loading && !error && <ul>{items.map((item) => {
          const Icon = TASK_CONVERSATION_SOURCE_ICONS[item.source]
          const linked = bindings.some((binding) => binding.conversation.id === item.id)
          const date = Number.isFinite(item.updatedAt) && item.updatedAt > 0 ? new Date(item.updatedAt) : null
          const updated = date && Number.isFinite(date.getTime()) ? date : null
          const updatedLabel = updated ? relTime(item.updatedAt) : '时间未记录'
          const duplicateTitle = (titleCounts.get(JSON.stringify([item.source, item.title])) ?? 0) > 1
          const shortId = item.sessionId.length > 16 ? `${item.sessionId.slice(0, 6)}…${item.sessionId.slice(-6)}` : item.sessionId
          return <li key={item.id}><button type="button" className="my-task-conversation-candidate" aria-pressed={selected === item.id}
            title={`${item.title}\n原生 ID：${item.sessionId}`} aria-label={`${item.title} · ${TASK_CONVERSATION_SOURCE_LABELS[item.source]} · ${capabilityLabel(item)} · ${updatedLabel} · 原生 ID：${item.sessionId}`}
            disabled={busy || linked} onClick={() => { setSelected(item.id); setMessage(null) }}>
            <Icon size={16} aria-hidden="true" />
            <span className="my-task-conversation-candidate__content"><span className="my-task-conversation-candidate__title">{item.title}</span>
              <span className="my-task-conversation-candidate__meta">{TASK_CONVERSATION_SOURCE_LABELS[item.source]} · {capabilityLabel(item)}{item.titleSource === 'fallback' ? ' · 原生 ID' : item.titleSource === 'summary' ? ' · 摘要标题' : ''}
                {' · '}{updated ? <time dateTime={updated.toISOString()} title={`最后更新：${updated.toLocaleString('zh-CN')}`}>{updatedLabel}</time> : <span>{updatedLabel}</span>}
                {duplicateTitle && <> · <span title={item.sessionId}>ID {shortId}</span></>}
              </span>
              {item.unavailableReason && <span className="my-task-conversation-candidate__meta">{item.unavailableReason}</span>}
            </span>
            {linked ? <span className="my-task-conversation-candidate__linked">已关联</span> : selected === item.id ? <Check size={14} aria-hidden="true" /> : null}
          </button></li>
        })}</ul>}
      </div>
      {candidates?.truncated && <p className="text-my-xs text-my-secondary">本次扫描结果已截断。</p>}
      {sources.length > 0 && <details className="my-task-conversation-association__sources"><summary>原生来源读取状态</summary><ul>{sources.map((item) => <li key={item.source}>{TASK_CONVERSATION_SOURCE_LABELS[item.source]} · {item.available ? '读取可用' : '暂不可用'}{item.detail ? ` · ${item.detail}` : ''}</li>)}</ul></details>}
      {(feedback || message) && <p className={feedback?.error ? 'text-my-xs text-my-danger-text' : 'text-my-xs text-my-secondary'} role={feedback?.error ? 'alert' : 'status'}>{feedback?.message ?? message}</p>}
      <footer className="my-task-conversation-association__footer">
        <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        <Button variant="primary" size="sm" disabled={!selected || alreadyLinked || busy || loading} onClick={() => { void attach() }}>{busy ? '处理中…' : '关联所选会话'}</Button>
      </footer>
    </div>
  </Modal>
}
