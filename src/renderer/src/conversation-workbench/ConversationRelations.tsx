import { useId, useState, type JSX } from 'react'
import { ArrowUpRight, Bot, Check, ChevronRight, CircleAlert, CircleHelp, GitBranch, LoaderCircle, MessageSquare, Minus, Square, X } from 'lucide-react'
import type { ConversationThreadRelation, ConversationThreadRelations } from '../../../shared/conversation/thread-relations'
import { getToolBrand } from '../../../shared/tool-brands'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Button, Modal } from '../my/ui'
import { conversationThreadSurface, type ConversationThreadSurface } from './conversationRightPanelStore'
import { formatDayAwareTimestamp } from './chatTimestamp'
import './conversation-relations.css'

export type ConversationThreadTab = ConversationThreadSurface

const workStatus = {
  idle: { label: '空闲', icon: Minus },
  queued: { label: '等待启动', icon: Minus },
  running: { label: '执行中', icon: LoaderCircle },
  waiting: { label: '等待答复', icon: CircleHelp },
  completed: { label: '已完成', icon: Check },
  failed: { label: '失败', icon: CircleAlert },
  cancelled: { label: '已取消', icon: X },
  'pending-reconciliation': { label: '待核对', icon: CircleHelp },
} satisfies Record<ConversationThreadRelation['status'], { readonly label: string; readonly icon: typeof Minus }>

const deliveryStatus = {
  available: '结果可查看',
  delivered: '已回传父会话',
  'read-only': '仅供查看',
} satisfies Record<NonNullable<ConversationThreadRelation['result']>['state'], string>

function isTerminal(status: ConversationThreadRelation['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isAgent(item: ConversationThreadRelation): boolean {
  return item.kind === 'delegated' || item.kind === 'native-activity'
}

function RelatedWorkDetails({ item, onClose }: {
  readonly item: ConversationThreadRelation
  readonly onClose: () => void
}): JSX.Element {
  return <Modal open onClose={onClose} ariaLabel={item.title} width={440}>
    <div className="conversation-related-details">
      <div className="conversation-related-details-heading">
        <h2 className="my-item-title">{item.title}</h2>
        <button type="button" className="my-icon-control" aria-label="关闭活动详情" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <dl>
        <dt>来源</dt><dd>{item.kind === 'native-activity' ? '引擎活动' : '应用委派'}</dd>
        <dt>状态</dt><dd>{workStatus[item.status].label}</dd>
        {item.model && <><dt>模型</dt><dd>{item.model}</dd></>}
        {item.activityId && <><dt>活动编号</dt><dd>{item.activityId}</dd></>}
        {item.result && <><dt>结果</dt><dd>{deliveryStatus[item.result.state]}</dd></>}
      </dl>
      {item.question && <p>{item.question.title}</p>}
      {item.result?.text && <p>{item.result.text}</p>}
    </div>
  </Modal>
}

function canStopChildAgent(item: ConversationThreadRelation): boolean {
  return item.kind === 'delegated'
    && Boolean(item.childThreadId)
    && (item.status === 'queued' || item.status === 'running' || item.status === 'waiting')
}

export function ConversationLifecycleCard({ item, onOpenRelatedThread, onStopSubagent, stoppingChildThreadId, compact = false }: {
  readonly item: ConversationThreadRelation
  readonly onOpenRelatedThread?: (tab: ConversationThreadTab) => void
  readonly onStopSubagent?: (childThreadId: string, force?: boolean) => void
  readonly stoppingChildThreadId?: string | null
  readonly compact?: boolean
}): JSX.Element {
  const [details, setDetails] = useState(false)
  const { label, icon: Status } = workStatus[item.status]
  const Kind = item.kind === 'side-chat' ? MessageSquare : item.kind === 'fork' ? GitBranch : Bot
  const child = item.childThreadId
  const note = item.question?.title ?? (item.result && deliveryStatus[item.result.state])
  const stoppable = Boolean(onStopSubagent && canStopChildAgent(item) && child)
  const stopping = Boolean(child && stoppingChildThreadId === child)
  const contents = <>
    <Kind size={15} aria-hidden="true" className="conversation-related-kind" />
    <span className="conversation-related-title my-item-title">{item.title}</span>
    <span className="conversation-related-state" data-state={item.status}>
      <Status size={13} aria-hidden="true" className={item.status === 'running' ? 'animate-spin' : undefined} />
      {label}
    </span>
    <ArrowUpRight size={13} className="conversation-related-open" aria-hidden="true" />
  </>
  return <div className={compact ? 'conversation-related-entry' : 'conversation-related-card'}
    data-conversation-row-id={compact ? undefined : `relation:${item.id}`} data-related-work-id={item.id}>
    <div className="conversation-related-trigger-row">
      <Button variant="ghost" size="sm" className="conversation-related-trigger"
        aria-label={`${child && onOpenRelatedThread ? '打开子会话' : '查看活动详情'}：${item.title}，${label}`}
        onClick={() => child && onOpenRelatedThread ? onOpenRelatedThread(conversationThreadSurface(child)) : setDetails(true)}>
        {contents}
      </Button>
      {stoppable && child && <button type="button" className="my-icon-control shrink-0"
        title={`停止子代理：${item.title}`} aria-label={`停止子代理：${item.title}`}
        disabled={stopping} onClick={() => onStopSubagent?.(child)}>
        {stopping
          ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Square size={11} aria-hidden="true" />}
      </button>}
    </div>
    {!compact && note && <p className="my-item-description conversation-related-note">{note}</p>}
    {details && <RelatedWorkDetails item={item} onClose={() => setDetails(false)} />}
  </div>
}

export function ConversationTimelineRelationRow({ item, onOpenRelatedThread, onStopSubagent, stoppingChildThreadId }: {
  readonly item: ConversationThreadRelation
  readonly onOpenRelatedThread?: (tab: ConversationThreadTab) => void
  readonly onStopSubagent?: (childThreadId: string, force?: boolean) => void
  readonly stoppingChildThreadId?: string | null
}): JSX.Element {
  const [details, setDetails] = useState(false)
  const { label, icon: Status } = workStatus[item.status]
  const Kind = item.kind === 'side-chat' ? MessageSquare : item.kind === 'fork' ? GitBranch : Bot
  const child = item.childThreadId
  const canOpen = Boolean(child && onOpenRelatedThread)
  const stoppable = Boolean(onStopSubagent && canStopChildAgent(item) && child)
  const stopping = Boolean(child && stoppingChildThreadId === child)
  const elapsed = formatDayAwareTimestamp(item.updatedAt)
  const open = (): void => {
    if (child && onOpenRelatedThread) onOpenRelatedThread(conversationThreadSurface(child))
    else setDetails(true)
  }
  if (isAgent(item)) {
    const brand = getToolBrand(item.instanceId)
    const detail = subagentCardDetail(item.result?.text ?? item.question?.title)
    return <div data-related-work-id={item.id} data-v2-item-type="subagent">
      <div className="conversation-related-trigger-row">
        <button type="button" className="conversation-subagent-link" data-state={item.status}
          aria-label={`${canOpen ? '打开子会话' : '查看活动详情'}：${item.title}，${label}`} onClick={open}>
          <span className="conversation-subagent-avatar" aria-hidden="true">
            {brand ? <ToolBrandIcon brand={brand.id} size={14} /> : <Bot size={14} />}
            <span className="conversation-subagent-dot" />
          </span>
          <span className="conversation-subagent-copy">
            <span className="conversation-subagent-title">{item.title}</span>
            <span className="conversation-subagent-detail">{detail ?? label}</span>
          </span>
          {detail && <span className="conversation-subagent-status">{label}</span>}
          {elapsed && <span className="conversation-subagent-time">{elapsed}</span>}
          <ChevronRight size={14} className="conversation-subagent-chevron" aria-hidden="true" />
        </button>
        {stoppable && child && <button type="button" className="my-icon-control shrink-0"
          title={`停止子代理：${item.title}`} aria-label={`停止子代理：${item.title}`}
          disabled={stopping} onClick={() => onStopSubagent?.(child)}>
          {stopping
            ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <Square size={11} aria-hidden="true" />}
        </button>}
      </div>
      {details && <RelatedWorkDetails item={item} onClose={() => setDetails(false)} />}
    </div>
  }
  return <div className="conversation-work-row conversation-related-row" data-related-work-id={item.id}
    data-state={item.status}>
    <button type="button" className="conversation-related-row-trigger"
      aria-label={`${canOpen ? '打开子会话' : '查看活动详情'}：${item.title}，${label}`}
      onClick={open}>
      <span className="conversation-work-icon" aria-hidden="true"><span><Kind size={16} /></span></span>
      <span className="conversation-related-row-title">{item.title}</span>
      <span className="conversation-related-state" data-state={item.status}>
        <Status size={13} aria-hidden="true" className={item.status === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined} />
        {label}
      </span>
      {elapsed && <span className="conversation-message-time conversation-related-row-time">{elapsed}</span>}
      {canOpen ? <ArrowUpRight size={14} className="conversation-related-row-open" aria-hidden="true" /> : null}
    </button>
    {details && <RelatedWorkDetails item={item} onClose={() => setDetails(false)} />}
  </div>
}

function subagentCardDetail(detail: string | undefined): string | null {
  if (!detail || /^Child task ended with status\b/i.test(detail)) return null
  return detail.slice(0, 4096)
    .replace(/!?\[([^\]]+)\]\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim() || null
}

export function ConversationRelations({ relations, onOpenRelatedThread, onStopSubagent, stoppingChildThreadId }: {
  readonly relations?: ConversationThreadRelations
  readonly onOpenRelatedThread: (tab: ConversationThreadTab) => void
  readonly onStopSubagent?: (childThreadId: string, force?: boolean) => void
  readonly stoppingChildThreadId?: string | null
}): JSX.Element | null {
  const historyId = useId()
  const children = relations?.children ?? []
  const current = children.filter(item => isAgent(item) && !isTerminal(item.status))
  const previous = children.filter(item => isAgent(item) && isTerminal(item.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const threads = children.filter(item => !isAgent(item) && item.childThreadId)
  const failures = previous.filter(item => item.status === 'failed').length
  if (!current.length && !previous.length && !threads.length) return null
  const list = (items: readonly ConversationThreadRelation[]) => <ul className="conversation-related-list">
    {items.map(item => <li key={item.id}>
      <ConversationLifecycleCard compact item={item} onOpenRelatedThread={onOpenRelatedThread}
        onStopSubagent={onStopSubagent} stoppingChildThreadId={stoppingChildThreadId} />
    </li>)}
  </ul>
  return <section aria-label="会话关系" className="conversation-relations">
    {current.length > 0 && list(current)}
    {previous.length > 0 && <details className="conversation-related-history">
      <summary aria-controls={historyId}>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="my-item-title">之前的智能体</span>
        {failures > 0 && <span className="conversation-related-state" data-state="failed">
          <CircleAlert size={13} aria-hidden="true" />{failures} 项失败
        </span>}
      </summary>
      <div id={historyId}>{list(previous)}</div>
    </details>}
    {threads.length > 0 && list(threads)}
  </section>
}

export function ConversationSubagentBar({ relations, onOpenRelatedThread, onStopSubagent, stoppingChildThreadId }: {
  readonly relations?: ConversationThreadRelations
  readonly onOpenRelatedThread: (tab: ConversationThreadTab) => void
  readonly onStopSubagent?: (childThreadId: string, force?: boolean) => void
  readonly stoppingChildThreadId?: string | null
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const agents = (relations?.children ?? []).filter(isAgent)
  if (!agents.length) return null

  const runningCount = agents.filter(item => item.status === 'running' || item.status === 'queued').length
  const waiting = agents.filter(item => item.status === 'waiting')
  const completedCount = agents.filter(item => item.status === 'completed').length
  const failedCount = agents.filter(item => item.status === 'failed' || item.status === 'pending-reconciliation').length
  const cancelledCount = agents.filter(item => item.status === 'cancelled').length
  const firstWaiting = waiting.find(item => Boolean(item.childThreadId))

  return (
    <section className="conversation-subagent-bar" aria-label="子代理运行状态汇总">
      <div className="conversation-subagent-bar-summary">
        <span className="conversation-subagent-bar-label">
          <Bot size={14} aria-hidden="true" />
          <span>子代理</span>
        </span>
        <div className="conversation-subagent-bar-counts">
          {runningCount > 0 && <span className="conversation-subagent-count">执行中 {runningCount}</span>}
          {waiting.length > 0 && <span className="conversation-subagent-count" data-tone="waiting">待答复 {waiting.length}</span>}
          {completedCount > 0 && <span className="conversation-subagent-count">已完成 {completedCount}</span>}
          {failedCount > 0 && <span className="conversation-subagent-count" data-tone="failed">异常 {failedCount}</span>}
          {cancelledCount > 0 && <span className="conversation-subagent-count">已取消 {cancelledCount}</span>}
        </div>
        <div className="conversation-subagent-bar-actions">
          {firstWaiting?.childThreadId && (
            <Button size="sm" variant="outline" onClick={() => onOpenRelatedThread(conversationThreadSurface(firstWaiting.childThreadId!))}>
              去答复
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded(current => !current)}
          >
            <span>{expanded ? '收起' : `查看全部 (${agents.length})`}</span>
            <ChevronRight size={13} className={expanded ? 'rotate-90' : undefined} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {expanded && (
        <ul id={panelId} className="conversation-related-list conversation-subagent-bar-list">
          {agents.map(item => (
            <li key={item.id}>
              <ConversationLifecycleCard
                compact
                item={item}
                onOpenRelatedThread={onOpenRelatedThread}
                onStopSubagent={onStopSubagent}
                stoppingChildThreadId={stoppingChildThreadId}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
