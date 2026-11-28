import { useEffect, useRef } from 'react'
import { isActiveRun, type ConversationThreadProjection } from './threadProjectionModel'
import { notifyThreadEvent } from './threadNotifications'

interface ObservedThreadState {
  readonly threadId: string
  readonly activeRunIds: ReadonlySet<string>
  readonly pendingRequestKeys: ReadonlySet<string>
}

/**
 * 监听当前活动会话的回合完成、报错以及新增审批/提问请求：
 * 首次加载快照仅记录基线不弹提醒，后续状态跃迁时若窗口处于后台或失焦则播放软音效并发送桌面通知。
 */
export function useThreadNotifications(
  projection: ConversationThreadProjection | undefined,
  displayTitle?: string,
): void {
  const observedRef = useRef<ObservedThreadState | null>(null)

  useEffect(() => {
    if (!projection) {
      observedRef.current = null
      return
    }
    const threadId = projection.thread.id
    const currentActiveIds = new Set<string>(
      projection.runs.filter((run) => run.status !== 'queued' && isActiveRun(run)).map((run) => run.id),
    )
    const currentPendingKeys = new Set(
      projection.runtimeRequests
        .filter((request) => request.status === 'pending')
        .map((request) => `${request.requestId}:${request.generation}`),
    )

    const previous = observedRef.current
    observedRef.current = {
      threadId,
      activeRunIds: currentActiveIds,
      pendingRequestKeys: currentPendingKeys,
    }

    // 首次挂载或刚切换会话时只建立基线，不误报历史状态
    if (!previous || previous.threadId !== threadId) return

    const title = displayTitle || projection.thread.title || '会话'

    for (const request of projection.runtimeRequests) {
      if (request.status !== 'pending') continue
      const key = `${request.requestId}:${request.generation}`
      if (previous.pendingRequestKeys.has(key)) continue
      notifyThreadEvent({
        eventKey: `req:${threadId}:${key}`,
        kind: request.payload.kind === 'approval' ? 'approval' : 'user-input',
        threadTitle: title,
        body: request.payload.title || '需要你确认后才能继续执行。',
      })
    }

    for (const runId of previous.activeRunIds) {
      if (currentActiveIds.has(runId)) continue
      const settled = projection.runs.find((run) => run.id === runId)
      if (!settled || settled.outcomeUnknown || settled.compaction) continue
      if (settled.status === 'completed') {
        notifyThreadEvent({
          eventKey: `run:${threadId}:${runId}:completed`,
          kind: 'completed',
          threadTitle: title,
          body: '模型已回复完毕，点击查看结果。',
        })
      } else if (settled.status === 'failed') {
        notifyThreadEvent({
          eventKey: `run:${threadId}:${runId}:failed`,
          kind: 'failed',
          threadTitle: title,
          body: settled.failure?.slice(0, 120) || '执行遇到错误，需要处理。',
        })
      }
    }
  }, [displayTitle, projection])
}
