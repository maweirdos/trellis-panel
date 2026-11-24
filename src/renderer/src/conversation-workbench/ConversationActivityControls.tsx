import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { ArrowRightLeft, ChevronRight, Columns2, Minimize2, Pause, Play, Target, X } from 'lucide-react'
import type { ConversationThreadCommand, ConversationThreadCommandState } from '../../../shared/conversation/command-runtime'
import { Select } from '../components/Select'
import { Button, Checkbox } from '../my/ui'
import type { ComposerModel } from './useComposerSend'
import type { CompareModelsInput } from './useSideChat'
import { isActiveRun, type ConversationApplyResult, type ConversationThreadController, type ConversationThreadProjection } from './useConversationThread'
import './conversation-relations.css'

type Handoff = Extract<ConversationThreadCommand, { type: 'thread.handoff' }>
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
  readonly comparisonModels?: readonly ComposerModel[]
  readonly onLoadComparisonModels?: () => Promise<void>
  readonly onCompareModels?: (input: CompareModelsInput) => Promise<boolean>
}

const number = new Intl.NumberFormat('zh-CN')

function modelKey(model: ComposerModel): string {
  return JSON.stringify([model.instanceId, model.id])
}

export function ConversationActivityControls(props: ConversationActivityControlsProps): JSX.Element | null {
  return props.projection ? <ScopedActivityControls key={props.controller.scope} {...props} projection={props.projection} /> : null
}

function ScopedActivityControls({
  controller, projection, disabled, compactAvailable, modelOptions = [], onHandoffAccepted, comparisonModels = [],
  onLoadComparisonModels, onCompareModels,
}: ConversationActivityControlsProps & { projection: ConversationThreadProjection }): JSX.Element {
  const [editor, setEditor] = useState<'goal' | 'handoff' | 'compare' | null>(null)
  const [objective, setObjective] = useState('')
  const [handoffModel, setHandoffModel] = useState('')
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
  const threadId = projection.thread.id
  const goal = projection.goal
  const usage = projection.runs.filter(run => run.usage).at(-1)?.usage
  const compaction = projection.runs.filter(run => run.compaction).at(-1)
  const handoffRun = projection.runs.filter(run => run.handoff).at(-1)
  const handoffContext = handoffRun?.handoff
  const handoffStatus = handoffRun?.outcomeUnknown ? '接力结果待核对'
    : handoffContext?.state === 'accepted' ? '新引擎已接收接力'
      : handoffRun && isActiveRun(handoffRun) ? '等待新引擎接收接力' : '接力未获引擎确认'
  const boundCompaction = compactReceipt && projection.runs.find(run => run.id === compactReceipt.runId)
  const compactPending = Boolean(compactReceipt && (!boundCompaction || isActiveRun(boundCompaction))) ||
    Boolean(compaction && isActiveRun(compaction))
  const blocked = disabled || busy || failure?.uncertain === true
  const compactBlocked = !compactAvailable || compactPending || projection.queuePaused || Boolean(projection.activeRun) ||
    projection.runtimeRequests.some(request => request.status === 'pending' || request.status === 'responding' ||
      request.status === 'pending-reconciliation')
  const handoffModels = modelOptions.filter(model => model.instanceId !== projection.thread.modelSelection.instanceId)
  const selection = handoffModels.find(model => modelKey(model) === handoffModel)
  const handoffCandidates = projection.messages.filter(message => !message.streaming && message.role !== 'system').slice(-16)
  const messageIds = handoffCandidates.filter(message => selectedMessages.has(message.id)).map(message => message.id)
  const source = projection.runs.filter(run => !run.outcomeUnknown && run.status === 'completed' && !run.compaction).at(-1)
  const modelsToCompare = comparisonModels.filter(model => compareModels.includes(modelKey(model)))
  const compareId = useId()

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

  return <details className="conversation-activity-controls">
    <summary className="my-item-title"><ChevronRight size={14} aria-hidden="true" />目标与上下文</summary>
    <div className="conversation-activity-body">
      <div className="conversation-activity-actions">
        <Button size="sm" variant="ghost" disabled={blocked} onClick={() => {
          setObjective(goal?.objective ?? '')
          setEditor(editor === 'goal' ? null : 'goal')
        }}><Target size={14} aria-hidden="true" />{goal ? '编辑目标' : '设置目标'}</Button>
        {goal && <>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void dispatch({
            type: goal.status === 'paused' ? 'thread.goal.resume' : 'thread.goal.pause', commandId: crypto.randomUUID(), threadId,
          })}>{goal.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {goal.status === 'paused' ? '继续' : '暂停'}</Button>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void dispatch({
            type: 'thread.goal.clear', commandId: crypto.randomUUID(), threadId,
          })}><X size={14} aria-hidden="true" />清除</Button>
        </>}
      </div>
      {goal && <p className="conversation-activity-objective"><span className="my-item-description">
        {goal.status === 'paused' ? '已暂停' : '将随下次发送带入'} · Crux 目标
      </span>{goal.objective}</p>}
      {editor === 'goal' && <form className="conversation-activity-form" onSubmit={event => {
        event.preventDefault()
        if (!blocked && objective.trim()) void dispatch({ type: 'thread.goal.set', commandId: crypto.randomUUID(), threadId, objective })
      }}>
        <label className="my-item-title" htmlFor={objectiveId}>目标</label>
        <textarea className="my-input" id={objectiveId} value={objective} maxLength={4_000} rows={3}
          disabled={blocked} onChange={event => setObjective(event.target.value)} />
        <Button size="sm" variant="primary" type="submit" disabled={blocked || !objective.trim()}>保存目标</Button>
      </form>}
      <div className="conversation-activity-actions">
        <Button size="sm" variant="ghost" disabled={blocked || compactBlocked} onClick={() => void dispatch({
          type: 'thread.compact', commandId: crypto.randomUUID(), threadId,
        })}><Minimize2 size={14} aria-hidden="true" />压缩上下文</Button>
        {handoffModels.length > 0 && <Button size="sm" variant="ghost" disabled={blocked || Boolean(projection.activeRun)}
          onClick={() => setEditor(editor === 'handoff' ? null : 'handoff')}>
          <ArrowRightLeft size={14} aria-hidden="true" />换引擎接力
        </Button>}
        {onCompareModels && (comparisonModels.length >= 2 || onLoadComparisonModels) && <Button size="sm" variant="ghost"
          disabled={blocked || !source} onClick={() => {
            setEditor(editor === 'compare' ? null : 'compare')
            if (editor !== 'compare' && comparisonModels.length < 2) void loadComparisonModels()
          }}>
          <Columns2 size={14} aria-hidden="true" />只读比较模型
        </Button>}
      </div>
      {compactPending && <p className="my-activity-note" role="status">正在压缩上下文…</p>}
      {compaction && !compactPending && <p className="my-item-description" role="status">
        {compaction.status === 'completed' ? '上下文已压缩' : compaction.outcomeUnknown ? '压缩结果待核对'
          : compaction.status === 'cancelled' || compaction.status === 'interrupted' ? '压缩已停止' : '压缩未完成'}
      </p>}
      {handoffContext && <p className="my-item-description" role="status">
        {handoffStatus} · 带入 {number.format(handoffContext.includedMessages)} 条消息
        {handoffContext.omittedMessages > 0 && ` · 省略 ${number.format(handoffContext.omittedMessages)} 条消息`}
        {handoffContext.omittedAttachments > 0 && ` · 省略 ${number.format(handoffContext.omittedAttachments)} 个附件`}
      </p>}
      {usage && <dl className="conversation-activity-usage" aria-label="引擎报告的用量">
        <dt>输入</dt><dd>{number.format(usage.inputTokens)}</dd>
        <dt>输出</dt><dd>{number.format(usage.outputTokens)}</dd>
        {usage.cachedInputTokens !== undefined && <><dt>缓存输入</dt><dd>{number.format(usage.cachedInputTokens)}</dd></>}
        {usage.reasoningOutputTokens !== undefined && <><dt>推理输出</dt><dd>{number.format(usage.reasoningOutputTokens)}</dd></>}
        {usage.contextWindow !== undefined && <><dt>上下文上限</dt><dd>{number.format(usage.contextWindow)}</dd></>}
      </dl>}
      {editor === 'handoff' && <form className="conversation-activity-form" onSubmit={event => {
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
        <label className="my-item-title" htmlFor={handoffId}>接力后的第一条消息</label>
        <textarea className="my-input" id={handoffId} value={handoffText} maxLength={120_000} rows={3}
          disabled={blocked} onChange={event => setHandoffText(event.target.value)} />
        <Button size="sm" variant="primary" type="submit"
          disabled={blocked || !selection || !handoffText.trim() || Boolean(projection.activeRun)}>接力并发送</Button>
      </form>}
      {editor === 'compare' && comparisonModels.length < 2 && <div className="conversation-activity-actions">
        <p className="my-item-description" role="status">
          {loadingComparisonModels ? '正在读取可比较模型…' : comparisonLoadFailed ? '无法读取可比较模型。' : '当前可比较模型不足两个。'}
        </p>
        {!loadingComparisonModels && onLoadComparisonModels && <Button size="sm" variant="ghost" disabled={blocked}
          onClick={() => void loadComparisonModels()}>重新读取模型</Button>}
      </div>}
      {editor === 'compare' && comparisonModels.length >= 2 && <form className="conversation-activity-form" onSubmit={event => {
        event.preventDefault()
        if (!blocked) void compare()
      }}>
        {compareModels.map((value, index) => <Select key={index} value={value} ariaLabel={`比较模型 ${index + 1}`}
          placeholder={index === 0 ? '选择第一个模型' : '选择第二个模型'} disabled={blocked}
          options={comparisonModels.map(model => ({ value: modelKey(model), label: model.displayName,
            disabled: modelKey(model) === compareModels[index === 0 ? 1 : 0] }))}
          onChange={next => setCompareModels(index === 0 ? [next, compareModels[1]] : [compareModels[0], next])} />)}
        <label className="my-item-title" htmlFor={compareId}>比较问题</label>
        <textarea id={compareId} className="my-input" rows={3} maxLength={120_000} value={compareText} disabled={blocked}
          onChange={event => setCompareText(event.target.value)} />
        <Button size="sm" variant="primary" type="submit" disabled={blocked || !source || !compareText.trim() || modelsToCompare.length !== 2}>
          启动只读比较
        </Button>
      </form>}
      {failure && <div className="conversation-activity-actions">
        <p role="status" className="my-item-description">{failure.reason}</p>
        {failure.uncertain && <Button size="sm" variant="ghost" disabled={busy || disabled}
          onClick={() => void dispatch()}>查询回执</Button>}
      </div>}
    </div>
  </details>
}
