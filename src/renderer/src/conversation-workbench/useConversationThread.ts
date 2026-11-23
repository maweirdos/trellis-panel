import { useEffect, useState } from 'react'
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from '../../../shared/conversation/orchestrationV2'
import { api } from '../api'
import { conversationError } from './useComposerSend'

export type ConversationThread = Pick<OrchestrationV2AppThread, 'id' | 'title' | 'modelSelection'>
export type ConversationMessage = Pick<OrchestrationV2ConversationMessage, 'id' | 'role' | 'text' | 'runId' | 'streaming'>
export type ConversationRun = Pick<OrchestrationV2Run, 'id' | 'status' | 'modelSelection' | 'userMessageId'> & {
  readonly failure?: string
  readonly outcomeUnknown?: boolean
  readonly engineAcceptedAt?: string | null
  readonly nativeTurnId?: string | null
}

interface ThreadProjection {
  thread: ConversationThread
  messages: readonly ConversationMessage[]
  runs: readonly ConversationRun[]
}

export interface ThreadReadTarget {
  readonly threadId: string
  readonly runId?: string
}

const ACTIVE_RUNS = new Set<ConversationRun['status']>(['preparing', 'queued', 'starting', 'running'])
const POLL_DELAY_MS = 450
const READ_RETRY_MS = 1_800

export function isActiveRun(run: ConversationRun): boolean {
  return !run.outcomeUnknown && ACTIVE_RUNS.has(run.status)
}

export function useConversationThread(root: string, target: ThreadReadTarget | null, interactive: boolean) {
  const [read, setRead] = useState<{ target: ThreadReadTarget; projection?: ThreadProjection; error?: string }>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!target || !interactive) return
    let cancelled = false
    let timer: number | undefined
    let failures = 0
    let polling = Boolean(target.runId)
    let asOfSequence: number | undefined

    async function refresh(selection: ThreadReadTarget, poll = false): Promise<void> {
      try {
        if (poll && asOfSequence !== undefined && typeof api.conversationEvents === 'function') {
          const tail = await api.conversationEvents({ cwd: root, threadId: selection.threadId, afterSequence: asOfSequence, limit: 1 }).catch(() => null)
          if (cancelled) return
          if (tail?.ok && tail.page?.events?.length === 0 && !tail.page.hasMore && tail.page.nextSequence === asOfSequence) {
            timer = window.setTimeout(() => void refresh(selection, true), POLL_DELAY_MS)
            return
          }
        }
        const result = await api.conversationRead(selection.threadId, root)
        if (cancelled) return
        if (!result.ok) throw new Error(result.error)
        const thread = result.thread as ConversationThread
        if (thread.id !== selection.threadId) throw new Error('未能读取所选会话。')
        const runs = result.runs as ConversationRun[]
        setRead({ target: selection, projection: { thread, messages: result.messages as ConversationMessage[], runs } })
        asOfSequence = Number.isSafeInteger(result.asOfSequence) && result.asOfSequence >= 0 ? result.asOfSequence : undefined
        failures = 0
        const run = selection.runId ? runs.find((item) => item.id === selection.runId) : runs.at(-1)
        polling = run ? isActiveRun(run) : Boolean(selection.runId)
        if (polling) timer = window.setTimeout(() => void refresh(selection, true), POLL_DELAY_MS)
      } catch (error) {
        if (cancelled) return
        const reason = conversationError(error)
        setRead((previous) => ({
          target: selection,
          projection: previous?.target === selection ? previous.projection : undefined,
          error: reason,
        }))
        failures += 1
        if (polling && failures < 3) timer = window.setTimeout(() => void refresh(selection), READ_RETRY_MS)
      }
    }

    void refresh(target)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [root, target, interactive, attempt])

  return {
    active: read?.target === target ? read : undefined,
    reload: () => setAttempt((value) => value + 1),
  }
}
