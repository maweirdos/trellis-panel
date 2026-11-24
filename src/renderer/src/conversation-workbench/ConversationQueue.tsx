import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { ArrowUp, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react'
import { Button } from '../my/ui'
import type {
  ConversationApplyResult,
  ConversationRun,
  ConversationThreadController,
} from './useConversationThread'

export interface ConversationQueueProps {
  readonly controller: ConversationThreadController
  readonly queued: ReadonlyArray<{ readonly run: ConversationRun; readonly text: string }>
  readonly queuePaused: boolean
  readonly disabled: boolean
  readonly onEditRequested?: (run: ConversationRun, text: string) => void
  /** Reported for an uncertain result so the caller can reconcile the original command. */
  readonly onCommandResult?: (result: ConversationApplyResult) => void
}

const VISIBLE_ROWS = 3

type CommandFailure = Extract<ConversationApplyResult, { ok: false }>

export function ConversationQueue(props: ConversationQueueProps): JSX.Element {
  return <ScopedConversationQueue key={props.controller.scope} {...props} />
}

function ScopedConversationQueue({
  controller,
  queued,
  queuePaused,
  disabled,
  onEditRequested,
  onCommandResult,
}: ConversationQueueProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<CommandFailure | null>(null)
  const listId = useId()
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  if (queued.length === 0 && !queuePaused && !failure) return null
  const collapsible = queued.length > VISIBLE_ROWS
  const visible = collapsible && !expanded ? queued.slice(0, VISIBLE_ROWS - 1) : queued
  const actionsDisabled = disabled || busy || failure?.uncertain === true

  async function execute(invoke: () => Promise<ConversationApplyResult>): Promise<void> {
    if (disabled || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const result = await invoke()
      if (!alive.current) return
      onCommandResult?.(result)
      setFailure(result.ok ? null : result)
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  return (
    <section className="conversation-queue" aria-label={`排队消息，共 ${queued.length} 条`}>
      <span className="sr-only" aria-live="polite">
        {queued.length} 条排队消息{queuePaused ? '，队列已暂停' : ''}
      </span>
      <ol className="conversation-queue-list" id={listId}>
        {visible.map(({ run: queuedRun, text }, position) => {
          const isLast = position === queued.length - 1
          return (
            <li
              key={queuedRun.id}
              className="conversation-queue-item"
              aria-posinset={position + 1}
              aria-setsize={queued.length}
              aria-label={`第 ${position + 1} 条排队消息，尚未发送`}
            >
              <div className="conversation-queue-bubble">
                <span className="conversation-queue-text">{text}</span>
              </div>
              <div className="conversation-queue-actions">
                <button
                  type="button"
                  className="my-icon-control"
                  title="立即发送"
                  aria-label="立即发送"
                  disabled={actionsDisabled}
                  onClick={() => void execute(() => controller.queue.start(queuedRun.id))}
                >
                  <ArrowUp size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="my-icon-control"
                  title="上移"
                  aria-label="上移"
                  disabled={actionsDisabled || position === 0}
                  onClick={() => {
                    const before = queued[position - 1]
                    if (before) void execute(() => controller.queue.reorder(queuedRun.id, before.run.id))
                  }}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  className="my-icon-control"
                  title="下移"
                  aria-label="下移"
                  disabled={actionsDisabled || isLast}
                  onClick={() => {
                    const after = queued[position + 2]
                    void execute(() => controller.queue.reorder(queuedRun.id, after?.run.id ?? null))
                  }}
                >
                  <ChevronDown size={13} />
                </button>
                <button
                  type="button"
                  className="my-icon-control"
                  title="编辑"
                  aria-label="编辑排队消息"
                  disabled={actionsDisabled || !onEditRequested}
                  onClick={() => onEditRequested?.(queuedRun, text)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="my-icon-control"
                  title="撤回"
                  aria-label="从队列撤回"
                  disabled={actionsDisabled}
                  onClick={() => void execute(() => controller.queue.cancel(queuedRun.id))}
                >
                  <X size={13} />
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      {collapsible && (
        <button
          type="button"
          className="conversation-queue-more my-item-description"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `展开全部 ${queued.length} 条`}
        </button>
      )}
      {queuePaused && (
        <div className="conversation-queue-paused" role="status">
          <span className="my-item-description">队列已暂停</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={actionsDisabled}
            onClick={() => void execute(controller.queue.resume)}
          >
            继续队列
          </Button>
        </div>
      )}
      {failure && (
        <div className="conversation-queue-paused">
          <p className="conversation-queue-failure" role="status">
            {failure.uncertain ? '队列操作结果待核对。' : failure.reason}
          </p>
          {failure.uncertain && (
            <Button size="sm" variant="ghost" disabled={disabled || busy}
              onClick={() => void execute(() => controller.checkCommand(failure.commandId))}>
              {busy ? '正在查询…' : '查询原操作回执'}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
