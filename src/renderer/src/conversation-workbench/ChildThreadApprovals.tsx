import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, ShieldAlert } from 'lucide-react'
import type { ConversationRuntimeRequest } from '../../../shared/conversation/command-runtime'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import type { ConversationThreadRelation, ConversationThreadRelations } from '../../../shared/conversation/thread-relations'
import { api } from '../api'
import { Button } from '../my/ui'
import { conversationThreadSurface, type ConversationThreadSurface } from './conversationRightPanelStore'
import { conversationError } from './useComposerSend'
import './conversation-enhancements.css'

export interface ChildThreadApprovalsProps {
  readonly cwd: string
  readonly relations?: ConversationThreadRelations
  readonly task?: ConversationTaskLocator
  readonly disabled: boolean
  readonly onOpenRelatedThread?: (surface: ConversationThreadSurface) => void
  readonly onResponded?: () => void
}

type WaitingChildRelation = ConversationThreadRelation & { readonly childThreadId: string }

interface ChildPendingEntry {
  readonly relation: WaitingChildRelation
  readonly requests: readonly ConversationRuntimeRequest[]
}

const POLL_MS = 1_500

export function ChildThreadApprovals({
  cwd,
  relations,
  task,
  disabled,
  onOpenRelatedThread,
  onResponded,
}: ChildThreadApprovalsProps): JSX.Element | null {
  const waitingChildren = useMemo(
    () => (relations?.children ?? []).filter(
      (child): child is WaitingChildRelation =>
        child.status === 'waiting' && typeof child.childThreadId === 'string' && child.childThreadId.length > 0,
    ),
    [relations?.children],
  )
  const waitingKey = waitingChildren.map((child) => `${child.childThreadId}:${child.question?.requestId ?? ''}`).join('|')
  const [entries, setEntries] = useState<readonly ChildPendingEntry[]>([])
  const [respondingKey, setRespondingKey] = useState<string | null>(null)
  const [errorByKey, setErrorByKey] = useState<Readonly<Record<string, string>>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (waitingChildren.length === 0) {
      setEntries([])
      return
    }
    let cancelled = false
    let timer: number | undefined

    const poll = async (): Promise<void> => {
      const next: ChildPendingEntry[] = []
      await Promise.all(waitingChildren.map(async (relation) => {
        try {
          const snapshot = await api.conversationRead(relation.childThreadId, cwd, task)
          if (!snapshot.ok) return
          const pending = snapshot.runtimeRequests.filter((request) => request.status === 'pending')
          if (pending.length > 0) next.push({ relation, requests: pending })
        } catch {
          // 读取单个子会话失败时跳过，不影响其他子会话审批
        }
      }))
      if (cancelled || !mounted.current) return
      setEntries(next)
      timer = window.setTimeout(() => void poll(), POLL_MS)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [cwd, task, waitingKey, waitingChildren])

  if (entries.length === 0) return null

  const respondApproval = async (
    childThreadId: string,
    request: ConversationRuntimeRequest,
    decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel',
  ): Promise<void> => {
    const key = `${childThreadId}:${request.requestId}:${request.generation}`
    if (disabled || respondingKey) return
    setRespondingKey(key)
    setErrorByKey((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    try {
      const result = await api.conversationApply({
        cwd,
        command: {
          type: 'runtime-request.respond',
          commandId: crypto.randomUUID(),
          threadId: childThreadId,
          requestId: request.requestId,
          generation: request.generation,
          decision,
        },
        ...(task ? { task } : {}),
      })
      if (!mounted.current) return
      if (!result.ok) {
        setErrorByKey((current) => ({ ...current, [key]: result.error }))
      } else {
        setEntries((current) => current
          .map((entry) => entry.relation.childThreadId !== childThreadId
            ? entry
            : { ...entry, requests: entry.requests.filter((item) => item.requestId !== request.requestId) })
          .filter((entry) => entry.requests.length > 0))
        onResponded?.()
      }
    } catch (error) {
      if (mounted.current) {
        setErrorByKey((current) => ({ ...current, [key]: conversationError(error) }))
      }
    } finally {
      if (mounted.current) setRespondingKey(null)
    }
  }

  return (
    <div className="conversation-child-approvals" aria-label="子会话待处理请求">
      {entries.map(({ relation, requests }) => {
        const active = requests[0]
        if (!active) return null
        const key = `${relation.childThreadId}:${active.requestId}:${active.generation}`
        const busy = respondingKey === key
        const error = errorByKey[key]
        const childLabel = relation.title || '子会话'
        return (
          <section key={key} className="conversation-request" data-request-kind={active.payload.kind}>
            <div className="conversation-request-card">
              <div className="conversation-request-header">
                <span className="conversation-request-eyebrow">
                  <ShieldAlert size={14} className="conversation-request-approval-icon" aria-hidden="true" />
                  <span>子会话等待处理</span>
                  <span className="conversation-child-approval-badge">{childLabel}</span>
                </span>
                <div className="conversation-child-approval-meta">
                  {requests.length > 1 && <span className="tabular-nums">+{requests.length - 1}</span>}
                  {onOpenRelatedThread && (
                    <button
                      type="button"
                      className="my-icon-control"
                      title={`打开子会话：${childLabel}`}
                      aria-label={`打开子会话：${childLabel}`}
                      onClick={() => onOpenRelatedThread(conversationThreadSurface(relation.childThreadId))}
                    >
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
              <p className="conversation-request-prompt">{active.payload.title}</p>
              {active.payload.kind === 'approval' && active.payload.details && (
                <pre className="conversation-request-detail my-scrollbar">{active.payload.details}</pre>
              )}
              <div className="conversation-request-actions">
                {active.payload.kind === 'approval' ? (
                  active.payload.options.map((option) => (
                    <Button
                      key={option.decision}
                      size="sm"
                      variant={option.decision === 'accept' ? 'primary' : option.decision === 'decline' ? 'outline' : 'ghost'}
                      disabled={disabled || busy}
                      onClick={() => void respondApproval(relation.childThreadId, active, option.decision)}
                    >
                      {option.label}
                    </Button>
                  ))
                ) : (
                  onOpenRelatedThread && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => onOpenRelatedThread(conversationThreadSurface(relation.childThreadId))}
                    >
                      前往子会话回答
                    </Button>
                  )
                )}
              </div>
              {error && <p className="conversation-request-failure mt-2" role="status">{error}</p>}
            </div>
          </section>
        )
      })}
    </div>
  )
}
