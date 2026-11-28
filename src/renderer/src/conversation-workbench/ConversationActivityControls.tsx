import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { ArrowRightLeft, ChevronRight, Columns2, Minimize2, Pause, Play, RefreshCw, Target, X } from 'lucide-react'
import type { ConversationThreadCommand, ConversationThreadCommandState, ConversationTurnUsage } from '../../../shared/conversation/command-runtime'
import { Select } from '../components/Select'
import { Button, Checkbox, Dropdown } from '../my/ui'
import type { ComposerModel } from './useComposerSend'
import type { CompareModelsInput } from './useSideChat'
import { isActiveRun, type ConversationApplyResult, type ConversationThreadController, type ConversationThreadProjection } from './useConversationThread'
import './conversation-relations.css'

type Handoff = Extract<ConversationThreadCommand, { type: 'thread.handoff' }>
type ProviderSwitch = Extract<ConversationThreadCommand, { type: 'provider.switch' }>
type Failure = Extract<ConversationApplyResult, { ok: false }>
type PendingActivity = { readonly command: ConversationThreadCommand; readonly failure?: Failure }
const pendingActivities = new Map<string, PendingActivity>()

export interface ConversationActivityControlsProps {
  readonly controller: ConversationThreadController
  readonly projection?: ConversationThreadProjection
  readonly disabled: boolean
  readonly compactAvailable: boolean
  readonly modelOptions?: readonly ComposerModel[]
  readonly onHandoffAccepted?: (receipt: ConversationThreadCommandState) => void
  readonly onProviderSwitched?: (model: ComposerModel) => void
  readonly comparisonModels?: readonly ComposerModel[]
  readonly onLoadComparisonModels?: () => Promise<void>
  readonly onCompareModels?: (input: CompareModelsInput) => Promise<boolean>
}

const exactNumber = new Intl.NumberFormat('zh-CN')

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(Math.round(tokens))
}

function formatPercent(ratio: number): string {
  const clamped = Math.max(0, Math.min(100, ratio * 100))
  if (clamped > 0 && clamped < 0.05) return '<0.1%'
  return `${clamped.toFixed(1)}%`
}

interface ContextUsageSummary {
  readonly totalTokens: number
  readonly limitTokens: number | null
  readonly ratio: number | null
  readonly tone: 'normal' | 'warning' | 'critical'
  readonly segments: ReadonlyArray<{
    readonly key: 'cached' | 'input' | 'output' | 'reasoning'
    readonly label: string
    readonly tokens: number
    readonly share: number
  }>
  readonly remainingTokens: number | null
}

function buildUsageSummary(usage: ConversationTurnUsage | undefined): ContextUsageSummary | null {
  if (!usage) return null
  const cached = Math.max(0, Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0))
  const freshInput = Math.max(0, usage.inputTokens - cached)
  const reasoning = Math.max(0, Math.min(usage.outputTokens, usage.reasoningOutputTokens ?? 0))
  const visibleOutput = Math.max(0, usage.outputTokens - reasoning)
  const totalTokens = Math.max(0, usage.inputTokens + usage.outputTokens)
  const limitTokens = usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : null
  const denom = limitTokens ?? (totalTokens > 0 ? totalTokens : 1)
  const ratio = limitTokens ? Math.max(0, Math.min(1, totalTokens / limitTokens)) : null
  const tone: ContextUsageSummary['tone'] = ratio !== null && ratio >= 0.9
    ? 'critical'
    : ratio !== null && ratio >= 0.75
      ? 'warning'
      : 'normal'
  const rawSegments: ContextUsageSummary['segments'] = [
    ...(cached > 0 ? [{ key: 'cached' as const, label: '缓存复用输入', tokens: cached, share: cached / denom }] : []),
    ...(freshInput > 0 ? [{ key: 'input' as const, label: '本步新增输入', tokens: freshInput, share: freshInput / denom }] : []),
    ...(visibleOutput > 0 ? [{ key: 'output' as const, label: '模型回复输出', tokens: visibleOutput, share: visibleOutput / denom }] : []),
    ...(reasoning > 0 ? [{ key: 'reasoning' as const, label: '推理过程输出', tokens: reasoning, share: reasoning / denom }] : []),
  ]
  const remainingTokens = limitTokens !== null ? Math.max(0, limitTokens - totalTokens) : null
  return { totalTokens, limitTokens, ratio, tone, segments: rawSegments, remainingTokens }
}

function ContextRingIcon({ ratio, tone }: { readonly ratio: number | null; readonly tone: 'normal' | 'warning' | 'critical' }): JSX.Element {
  const radius = 5.75
  const circumference = 2 * Math.PI * radius
  const progress = ratio !== null ? Math.max(0.06, Math.min(1, ratio)) : 0
  const dashOffset = circumference * (1 - progress)
  return (
    <svg className="conversation-context-ring" data-tone={tone} viewBox="0 0 16 16" width={15} height={15} aria-hidden="true">
      <circle className="conversation-context-ring-track" cx="8" cy="8" r={radius} fill="none" strokeWidth="1.8" />
      {ratio !== null && (
        <circle
          className="conversation-context-ring-fill"
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

function modelKey(model: ComposerModel): string {
  return JSON.stringify([model.instanceId, model.id])
}

export function ConversationActivityControls(props: ConversationActivityControlsProps): JSX.Element | null {
  return props.projection ? <ScopedActivityControls key={props.controller.scope} {...props} projection={props.projection} /> : null
}

function ScopedActivityControls({
  controller, projection, disabled, compactAvailable, modelOptions = [], onHandoffAccepted, onProviderSwitched, comparisonModels = [],
  onLoadComparisonModels, onCompareModels,
}: ConversationActivityControlsProps & { projection: ConversationThreadProjection }): JSX.Element {
  const [editor, setEditor] = useState<'goal' | 'handoff' | 'switch' | 'compare' | null>(null)
  const [objective, setObjective] = useState('')
  const [handoffModel, setHandoffModel] = useState('')
  const [switchModel, setSwitchModel] = useState('')
  const [handoffText, setHandoffText] = useState('')
  const [selectedMessages, setSelectedMessages] = useState<ReadonlySet<string>>(new Set())
  const [compareText, setCompareText] = useState('')
  const [compareModels, setCompareModels] = useState<readonly [string, string]>(['', ''])
  const [loadingComparisonModels, setLoadingComparisonModels] = useState(false)
  const [comparisonLoadFailed, setComparisonLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(() => pendingActivities.get(controller.scope)?.failure)
  const [compactReceipt, setCompactReceipt] = useState<ConversationThreadCommandState>()
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const objectiveId = useId()
  const handoffId = useId()
  const compareId = useId()
  const threadId = projection.thread.id
  const goal = projection.goal
  const usage = projection.runs.filter(run => run.usage).at(-1)?.usage
  const summary = buildUsageSummary(usage)
  const compaction = projection.runs.filter(run => run.compaction).at(-1)
  const handoffRun = projection.runs.filter(run => run.handoff).at(-1)
  const handoffContext = handoffRun?.handoff
  const handoffStatus = handoffRun?.outcomeUnknown ? '接力结果待核对'
    : handoffContext?.state === 'accepted' ? '新线程已接收接力'
      : handoffRun && isActiveRun(handoffRun) ? '等待新线程接收接力' : '接力未获引擎确认'
  const boundCompaction = compactReceipt && projection.runs.find(run => run.id === compactReceipt.runId)
  const compactPending = Boolean(compactReceipt && (!boundCompaction || isActiveRun(boundCompaction))) ||
    Boolean(compaction && isActiveRun(compaction))
  const blocked = disabled || busy || failure?.uncertain === true
  const compactBlocked = !compactAvailable || compactPending || projection.queuePaused || Boolean(projection.activeRun) ||
    projection.runs.some(run => run.outcomeUnknown) ||
    projection.runtimeRequests.some(request => request.status === 'pending' || request.status === 'responding' ||
      request.status === 'pending-reconciliation')
  const handoffModels = modelOptions
  const selection = handoffModels.find(model => modelKey(model) === handoffModel)
  const switchSelection = handoffModels.find(model => modelKey(model) === switchModel)
  const hasBlockingRequest = projection.runtimeRequests.some(request => request.status === 'pending' || request.status === 'responding' ||
    request.status === 'pending-reconciliation')
  const switchBlocked = blocked || Boolean(projection.activeRun) || projection.queuedRuns.length > 0 || hasBlockingRequest
  const handoffCandidates = projection.messages.filter(message => !message.streaming && message.role !== 'system').slice(-16)
  const messageIds = handoffCandidates.filter(message => selectedMessages.has(message.id)).map(message => message.id)
  const source = projection.runs.filter(run => !run.outcomeUnknown && ['completed', 'cancelled', 'interrupted'].includes(run.status) && !run.compaction).at(-1)
  const modelsToCompare = comparisonModels.filter(model => compareModels.includes(modelKey(model)))

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function dispatch(operation?: ConversationThreadCommand): Promise<void> {
    const pending = pendingActivities.get(controller.scope)
    if (disabled || inFlight.current || (!operation && !pending)) return
    const command = pending?.command ?? operation
    if (!command) return
    pendingActivities.set(controller.scope, { command, failure: pending?.failure })
    inFlight.current = true
    setBusy(true)
    try {
      const result = pending ? await controller.checkCommand(command.commandId) : await controller.apply(command)
      if (result.ok || !result.uncertain) pendingActivities.delete(controller.scope)
      else pendingActivities.set(controller.scope, { command, failure: result })
      if (!mounted.current) return
      setFailure(result.ok ? undefined : result)
      if (!result.ok) return
      if (command.type === 'thread.compact' && result.receipt.dispatch !== 'completed') setCompactReceipt(result.receipt)
      if (command.type === 'thread.handoff') {
        setHandoffText('')
        setSelectedMessages(new Set())
        onHandoffAccepted?.(result.receipt)
      }
      if (command.type === 'provider.switch') {
        const applied = handoffModels.find(model => model.instanceId === command.instanceId && model.id === command.model)
        if (applied) onProviderSwitched?.(applied)
      }
      setEditor(null)
      controller.reload()
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function handoff(): void {
    if (!selection || !handoffText.trim()) return
    const command: Handoff = {
      type: 'thread.handoff', commandId: crypto.randomUUID(), threadId, messageId: crypto.randomUUID(),
      instanceId: selection.instanceId, model: selection.id, text: handoffText,
      ...(selection.options?.length && { options: [...selection.options] }),
      ...(messageIds.length > 0 && { references: [{ threadId, messageIds }] }),
    }
    void dispatch(command)
  }

  function switchEngine(): void {
    if (!switchSelection || switchBlocked) return
    const command: ProviderSwitch = {
      type: 'provider.switch',
      commandId: crypto.randomUUID(),
      threadId,
      instanceId: switchSelection.instanceId,
      model: switchSelection.id,
      ...(switchSelection.options?.length ? { options: [...switchSelection.options] } : {}),
    }
    void dispatch(command)
  }

  async function compare(): Promise<void> {
    if (!source || !onCompareModels || !compareText.trim() || modelsToCompare.length !== 2 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      if (await onCompareModels({ runId: source.id, text: compareText.trim(), models: modelsToCompare }) && mounted.current) {
        setCompareText('')
        setEditor(null)
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function loadComparisonModels(): Promise<void> {
    if (!onLoadComparisonModels || loadingComparisonModels) return
    setLoadingComparisonModels(true)
    setComparisonLoadFailed(false)
    try {
      await onLoadComparisonModels()
    } catch {
      if (mounted.current) setComparisonLoadFailed(true)
    } finally {
      if (mounted.current) setLoadingComparisonModels(false)
    }
  }

  const triggerTitle = summary?.limitTokens
    ? `上下文窗口：已使用 ${formatPercent(summary.ratio ?? 0)}（${exactNumber.format(summary.totalTokens)} / ${exactNumber.format(summary.limitTokens)} tokens）`
    : summary
      ? `上下文用量：${exactNumber.format(summary.totalTokens)} tokens`
      : '上下文窗口与会话操作'

  return (
    <Dropdown
      placement="top"
      align="right"
      width={296}
      gap={8}
      layoutKey={`${editor ?? 'none'}:${Boolean(goal)}:${Boolean(summary)}`}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="my-icon-control conversation-context-trigger shrink-0"
          data-tone={summary?.tone ?? 'normal'}
          title={triggerTitle}
          aria-label={triggerTitle}
          aria-expanded={open}
          onClick={toggle}
        >
          <ContextRingIcon ratio={summary ? (summary.ratio ?? 0.22) : null} tone={summary?.tone ?? 'normal'} />
        </button>
      )}
    >
      {() => (
        <div className="conversation-context-popover">
          <div className="conversation-context-section">
            <div className="conversation-context-head">
              <span className="conversation-context-head-title">上下文窗口</span>
              {goal && (
                <span className="conversation-context-head-chip">
                  {goal.status === 'paused' ? '目标暂停' : '目标生效'}
                </span>
              )}
            </div>

            {summary ? (
              <div className="conversation-context-usage">
                <div className="conversation-context-usage-row">
                  <strong className="conversation-context-usage-percent" data-tone={summary.tone}>
                    {summary.ratio !== null ? `已使用 ${formatPercent(summary.ratio)}` : '本轮累计用量'}
                  </strong>
                  <span
                    className="conversation-context-usage-total"
                    title={summary.limitTokens
                      ? `${exactNumber.format(summary.totalTokens)} / ${exactNumber.format(summary.limitTokens)}`
                      : exactNumber.format(summary.totalTokens)}
                  >
                    {summary.limitTokens
                      ? `${formatCompactTokens(summary.totalTokens)} / ${formatCompactTokens(summary.limitTokens)}`
                      : `${formatCompactTokens(summary.totalTokens)} tokens`}
                  </span>
                </div>

                <div className="conversation-context-bar" aria-hidden="true">
                  {summary.segments.map((segment) => (
                    <span
                      key={segment.key}
                      className="conversation-context-bar-seg"
                      data-segment={segment.key}
                      style={{ width: `${Math.max(1.2, Math.min(100, segment.share * 100))}%` }}
                    />
                  ))}
                </div>

                <dl className="conversation-context-breakdown" aria-label="上下文用量明细">
                  {summary.segments.map((segment) => (
                    <div key={segment.key} className="conversation-context-breakdown-row">
                      <dt>
                        <span className="conversation-context-swatch" data-segment={segment.key} aria-hidden="true" />
                        <span>{segment.label}</span>
                      </dt>
                      <dd>
                        <span className="conversation-context-tokens" title={exactNumber.format(segment.tokens)}>
                          {formatCompactTokens(segment.tokens)}
                        </span>
                        <span className="conversation-context-share">{formatPercent(segment.share)}</span>
                      </dd>
                    </div>
                  ))}
                  {summary.remainingTokens !== null && summary.limitTokens && (
                    <div className="conversation-context-breakdown-row conversation-context-breakdown-remaining">
                      <dt>
                        <span className="conversation-context-swatch" data-segment="remaining" aria-hidden="true" />
                        <span>剩余空间</span>
                      </dt>
                      <dd>
                        <span className="conversation-context-tokens" title={exactNumber.format(summary.remainingTokens)}>
                          {formatCompactTokens(summary.remainingTokens)}
                        </span>
                        <span className="conversation-context-share">
                          {formatPercent(summary.remainingTokens / summary.limitTokens)}
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : (
              <p className="conversation-context-empty">
                模型回复完成后将自动展示当前上下文窗口占用。
              </p>
            )}
          </div>

          <div className="my-menu-divider" role="separator" />

          <div className="conversation-context-menu-list">
            <button
              type="button"
              className="my-menu-item"
              disabled={blocked || compactBlocked}
              onClick={() => void dispatch({ type: 'thread.compact', commandId: crypto.randomUUID(), threadId })}
            >
              <span className="my-menu-icon"><Minimize2 size={14} aria-hidden="true" /></span>
              <span className="min-w-0 flex-1 truncate">压缩上下文</span>
              {compactPending ? (
                <span className="my-menu-shortcut">进行中…</span>
              ) : compaction?.status === 'completed' ? (
                <span className="my-menu-shortcut">已压缩</span>
              ) : null}
            </button>

            <button
              type="button"
              className="my-menu-item"
              aria-expanded={editor === 'goal'}
              disabled={blocked}
              onClick={() => {
                setObjective(goal?.objective ?? '')
                setEditor(editor === 'goal' ? null : 'goal')
              }}
            >
              <span className="my-menu-icon"><Target size={14} aria-hidden="true" /></span>
              <span className="min-w-0 flex-1 truncate">会话目标</span>
              <span className="my-menu-shortcut">{goal ? (goal.status === 'paused' ? '已暂停' : '生效中') : '未设置'}</span>
              <ChevronRight size={13} className={editor === 'goal' ? 'my-menu-chevron conversation-context-chevron-open' : 'my-menu-chevron'} aria-hidden="true" />
            </button>

            {editor === 'goal' && (
              <div className="conversation-context-inline-panel">
                {goal && (
                  <div className="conversation-context-inline-bar">
                    <button type="button" className="conversation-context-link-btn" disabled={blocked} onClick={() => void dispatch({
                      type: goal.status === 'paused' ? 'thread.goal.resume' : 'thread.goal.pause', commandId: crypto.randomUUID(), threadId,
                    })}>
                      {goal.status === 'paused' ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
                      <span>{goal.status === 'paused' ? '继续生效' : '暂停目标'}</span>
                    </button>
                    <button type="button" className="conversation-context-link-btn" disabled={blocked} onClick={() => void dispatch({
                      type: 'thread.goal.clear', commandId: crypto.randomUUID(), threadId,
                    })}>
                      <X size={12} aria-hidden="true" />
                      <span>清除</span>
                    </button>
                  </div>
                )}
                <form className="conversation-activity-form" onSubmit={event => {
                  event.preventDefault()
                  if (!blocked && objective.trim()) void dispatch({ type: 'thread.goal.set', commandId: crypto.randomUUID(), threadId, objective })
                }}>
                  <label className="sr-only" htmlFor={objectiveId}>会话目标</label>
                  <textarea className="my-input" id={objectiveId} value={objective} maxLength={4_000} rows={3}
                    placeholder="输入持续随下次消息带入的会话目标…"
                    disabled={blocked} onChange={event => setObjective(event.target.value)} />
                  <Button size="sm" variant="primary" type="submit" disabled={blocked || !objective.trim()}>保存目标</Button>
                </form>
              </div>
            )}

            {handoffModels.length > 0 && (
              <>
                <button
                  type="button"
                  className="my-menu-item"
                  aria-expanded={editor === 'switch'}
                  disabled={switchBlocked}
                  onClick={() => {
                    if (!switchModel) {
                      const currentKey = JSON.stringify([projection.thread.modelSelection.instanceId, projection.thread.modelSelection.model])
                      setSwitchModel(currentKey)
                    }
                    setEditor(editor === 'switch' ? null : 'switch')
                  }}
                >
                  <span className="my-menu-icon"><RefreshCw size={14} aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1 truncate">切换模型/引擎</span>
                  <ChevronRight size={13} className={editor === 'switch' ? 'my-menu-chevron conversation-context-chevron-open' : 'my-menu-chevron'} aria-hidden="true" />
                </button>
                {editor === 'switch' && (
                  <div className="conversation-context-inline-panel">
                    <form className="conversation-activity-form" onSubmit={event => {
                      event.preventDefault()
                      switchEngine()
                    }}>
                      <Select ariaLabel="目标模型或引擎" value={switchModel} placeholder="选择目标模型/引擎" onChange={setSwitchModel} disabled={switchBlocked}
                        options={handoffModels.map(model => ({ value: modelKey(model), label: model.displayName }))} />
                      <p className="my-item-description">切换后不立即发消息；跨引擎或配置变更时，下次发送将自动带入本会话历史。</p>
                      <Button size="sm" variant="primary" type="submit" disabled={switchBlocked || !switchSelection}>
                        确认切换
                      </Button>
                    </form>
                  </div>
                )}
                <button
                  type="button"
                  className="my-menu-item"
                  aria-expanded={editor === 'handoff'}
                  disabled={blocked || Boolean(projection.activeRun)}
                  onClick={() => setEditor(editor === 'handoff' ? null : 'handoff')}
                >
                  <span className="my-menu-icon"><ArrowRightLeft size={14} aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1 truncate">上下文接力</span>
                  <ChevronRight size={13} className={editor === 'handoff' ? 'my-menu-chevron conversation-context-chevron-open' : 'my-menu-chevron'} aria-hidden="true" />
                </button>
                {editor === 'handoff' && (
                  <div className="conversation-context-inline-panel">
                    <form className="conversation-activity-form" onSubmit={event => {
                      event.preventDefault()
                      if (!blocked && !projection.activeRun) handoff()
                    }}>
                      <Select ariaLabel="接力模型" value={handoffModel} placeholder="选择接力模型" onChange={setHandoffModel} disabled={blocked}
                        options={handoffModels.map(model => ({ value: modelKey(model), label: model.displayName }))} />
                      {handoffCandidates.length > 0 && <details className="conversation-handoff-history">
                        <summary className="my-item-title">{messageIds.length ? `已选 ${messageIds.length} 条消息` : '带入原会话近期正文'}</summary>
                        <fieldset className="conversation-handoff-options" disabled={blocked} aria-label="选择要带入的消息">
                          <ul className="conversation-related-list">
                            {handoffCandidates.map(message => <li key={message.id}>
                              <label title={message.text}>
                                <Checkbox checked={selectedMessages.has(message.id)} onChange={checked => {
                                  if (blocked) return
                                  setSelectedMessages(current => {
                                    const next = new Set(current)
                                    if (checked) next.add(message.id)
                                    else next.delete(message.id)
                                    return next
                                  })
                                }} />
                                <span>{message.role === 'user' ? '你的消息' : '模型回复'} · {message.text}</span>
                              </label>
                            </li>)}
                          </ul>
                        </fieldset>
                      </details>}
                      <label className="sr-only" htmlFor={handoffId}>接力后的第一条消息</label>
                      <textarea className="my-input" id={handoffId} value={handoffText} maxLength={120_000} rows={3}
                        placeholder="输入接力后的第一条消息…"
                        disabled={blocked} onChange={event => setHandoffText(event.target.value)} />
                      <Button size="sm" variant="primary" type="submit"
                        disabled={blocked || !selection || !handoffText.trim() || Boolean(projection.activeRun)}>接力并发送</Button>
                    </form>
                  </div>
                )}
              </>
            )}

            {onCompareModels && (comparisonModels.length >= 2 || onLoadComparisonModels) && (
              <>
                <button
                  type="button"
                  className="my-menu-item"
                  aria-expanded={editor === 'compare'}
                  disabled={blocked || !source}
                  onClick={() => {
                    setEditor(editor === 'compare' ? null : 'compare')
                    if (editor !== 'compare' && comparisonModels.length < 2) void loadComparisonModels()
                  }}
                >
                  <span className="my-menu-icon"><Columns2 size={14} aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1 truncate">对比其他模型</span>
                  <ChevronRight size={13} className={editor === 'compare' ? 'my-menu-chevron conversation-context-chevron-open' : 'my-menu-chevron'} aria-hidden="true" />
                </button>
                {editor === 'compare' && (
                  <div className="conversation-context-inline-panel">
                    {comparisonModels.length < 2 ? (
                      <div className="conversation-activity-actions">
                        <p className="my-item-description" role="status">
                          {loadingComparisonModels ? '正在读取可比较模型…' : comparisonLoadFailed ? '无法读取可比较模型。' : '当前可比较模型不足两个。'}
                        </p>
                        {!loadingComparisonModels && onLoadComparisonModels && <Button size="sm" variant="ghost" disabled={blocked}
                          onClick={() => void loadComparisonModels()}>重新读取</Button>}
                      </div>
                    ) : (
                      <form className="conversation-activity-form" onSubmit={event => {
                        event.preventDefault()
                        if (!blocked) void compare()
                      }}>
                        {compareModels.map((value, index) => <Select key={index} value={value} ariaLabel={`比较模型 ${index + 1}`}
                          placeholder={index === 0 ? '选择第一个模型' : '选择第二个模型'} disabled={blocked}
                          options={comparisonModels.map(model => ({ value: modelKey(model), label: model.displayName,
                            disabled: modelKey(model) === compareModels[index === 0 ? 1 : 0] }))}
                          onChange={next => setCompareModels(index === 0 ? [next, compareModels[1]] : [compareModels[0], next])} />)}
                        <label className="sr-only" htmlFor={compareId}>比较问题</label>
                        <textarea id={compareId} className="my-input" rows={3} maxLength={120_000} value={compareText} disabled={blocked}
                          placeholder="输入要横向比较的问题…"
                          onChange={event => setCompareText(event.target.value)} />
                        <Button size="sm" variant="primary" type="submit" disabled={blocked || !source || !compareText.trim() || modelsToCompare.length !== 2}>
                          启动只读比较
                        </Button>
                      </form>
                    )}
                  </div>
                )}
              </>
            )}

            {handoffContext && (
              <p className="conversation-context-footnote" role="status">
                {handoffStatus} · 带入 {exactNumber.format(handoffContext.includedMessages)} 条消息
              </p>
            )}
            {failure && (
              <div className="conversation-context-inline-panel">
                <p role="status" className="my-item-description">{failure.reason}</p>
                {failure.uncertain && <Button size="sm" variant="ghost" disabled={busy || disabled}
                  onClick={() => void dispatch()}>查询回执</Button>}
              </div>
            )}
          </div>
        </div>
      )}
    </Dropdown>
  )
}
