import { useEffect, useMemo, useState, type JSX } from 'react'
import { FileCode, History, RefreshCw, RotateCcw } from 'lucide-react'
import type { ConversationCheckpointSummary } from '../../../shared/conversation/command-runtime'
import type { ConversationCheckpointDiffResult } from '../../../shared/conversation/desktop'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { api } from '../api'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { UnifiedDiff } from '../my/git/UnifiedDiff'
import { Button } from '../my/ui'
import { conversationFileSurface, type ConversationRightPanelSurface } from './conversationRightPanelStore'
import { formatDayAwareTimestamp } from './chatTimestamp'
import { conversationError } from './useComposerSend'
import type { ConversationMessage, ConversationRun } from './useConversationThread'
import './conversation-enhancements.css'

export interface ConversationCheckpointsPanelProps {
  readonly cwd: string
  readonly threadId: string
  readonly task?: ConversationTaskLocator
  readonly runs: readonly ConversationRun[]
  readonly messages: readonly ConversationMessage[]
  readonly checkpoints: readonly ConversationCheckpointSummary[]
  readonly initialRunId?: string
  readonly projectAvailable: boolean
  readonly canRollback: boolean
  readonly onOpenSurface?: (surface: ConversationRightPanelSurface) => void
  readonly onRollbackRun?: (runId: string, boundary: 'before' | 'after') => void
}

interface GroupedCheckpointRun {
  readonly run: ConversationRun
  readonly promptPreview: string
  readonly before?: ConversationCheckpointSummary
  readonly after?: ConversationCheckpointSummary
}

const FILE_STATUS_BADGE: Record<'added' | 'modified' | 'deleted' | 'renamed', string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

export function ConversationCheckpointsPanel({
  cwd,
  threadId,
  task,
  runs,
  messages,
  checkpoints,
  initialRunId,
  projectAvailable,
  canRollback,
  onOpenSurface,
  onRollbackRun,
}: ConversationCheckpointsPanelProps): JSX.Element {
  const grouped = useMemo<readonly GroupedCheckpointRun[]>(() => {
    const byRun = new Map<string, { before?: ConversationCheckpointSummary; after?: ConversationCheckpointSummary }>()
    for (const checkpoint of checkpoints) {
      const slot = byRun.get(checkpoint.runId) ?? {}
      if (checkpoint.phase === 'before') slot.before = checkpoint
      else slot.after = checkpoint
      byRun.set(checkpoint.runId, slot)
    }
    const messageById = new Map(messages.map((message) => [message.id, message]))
    return [...runs]
      .filter((run) => byRun.has(run.id))
      .sort((left, right) => right.ordinal - left.ordinal)
      .map((run) => {
        const entry = byRun.get(run.id)!
        const prompt = messageById.get(run.userMessageId)?.text.trim() ?? ''
        const firstLine = prompt.split(/\r?\n/, 1)[0] ?? ''
        return {
          run,
          promptPreview: firstLine.slice(0, 72) || `第 ${run.ordinal} 轮执行`,
          before: entry.before,
          after: entry.after,
        }
      })
  }, [checkpoints, messages, runs])

  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => initialRunId ?? grouped[0]?.run.id ?? null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [diffState, setDiffState] = useState<{
    readonly runId: string
    readonly loading: boolean
    readonly result?: ConversationCheckpointDiffResult
    readonly error?: string
  } | null>(null)

  useEffect(() => {
    if (initialRunId && grouped.some((item) => item.run.id === initialRunId)) {
      setSelectedRunId(initialRunId)
    }
  }, [initialRunId, grouped])

  const activeRunId = selectedRunId && grouped.some((item) => item.run.id === selectedRunId)
    ? selectedRunId
    : grouped[0]?.run.id ?? null

  const activeGroup = grouped.find((item) => item.run.id === activeRunId) ?? null

  useEffect(() => {
    if (!activeRunId || !activeGroup) {
      setDiffState(null)
      return
    }
    const hasCaptured = activeGroup.before?.status === 'captured' || activeGroup.after?.status === 'captured'
    if (!hasCaptured) {
      setDiffState({ runId: activeRunId, loading: false, error: activeGroup.before?.detail ?? activeGroup.after?.detail ?? '此轮未捕获可用的文件检查点快照。' })
      return
    }
    let cancelled = false
    setDiffState({ runId: activeRunId, loading: true })
    void api.conversationCheckpointDiff({
      cwd,
      threadId,
      runId: activeRunId,
      ...(task ? { task } : {}),
    }).then((response) => {
      if (cancelled) return
      if (!response.ok) {
        setDiffState({ runId: activeRunId, loading: false, error: response.error })
        return
      }
      setDiffState({ runId: activeRunId, loading: false, result: response.result })
    }).catch((error) => {
      if (cancelled) return
      setDiffState({ runId: activeRunId, loading: false, error: conversationError(error) })
    })
    return () => { cancelled = true }
  }, [activeGroup, activeRunId, cwd, refreshNonce, task, threadId])

  if (grouped.length === 0) {
    return (
      <div className="conversation-checkpoints-panel">
        <div className="conversation-project-toolbar">
          <History size={15} aria-hidden="true" />
          <h2 className="my-item-title">检查点与文件差异</h2>
        </div>
        <p className="my-item-description">
          当前会话还没有生成检查点记录。发送对话修改文件后，系统会自动在每轮前后捕获快照，支持查看差异和一键回滚。
        </p>
      </div>
    )
  }

  const activeDiff = diffState?.runId === activeRunId ? diffState : null
  const totalAdded = activeDiff?.result?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0
  const totalRemoved = activeDiff?.result?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0

  return (
    <div className="conversation-checkpoints-panel">
      <div className="conversation-project-toolbar">
        <History size={15} aria-hidden="true" />
        <h2 className="my-item-title">检查点与文件差异</h2>
        <button
          type="button"
          className="my-icon-control"
          title="重新读取差异"
          aria-label="重新读取差异"
          onClick={() => setRefreshNonce((value) => value + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      <ul className="conversation-checkpoint-list" aria-label="检查点列表">
        {grouped.map((group) => {
          const selected = group.run.id === activeRunId
          const summary = group.after ?? group.before
          const status = group.before?.status === 'captured' || group.after?.status === 'captured'
            ? 'captured'
            : summary?.status ?? 'skipped'
          const statusLabel = status === 'captured' ? '已捕获' : status === 'failed' ? '捕获失败' : '已跳过'
          const timestamp = summary?.createdAt ? formatDayAwareTimestamp(summary.createdAt) : ''
          return (
            <li key={group.run.id} className="conversation-checkpoint-item" data-selected={selected ? 'true' : undefined}>
              <div className="conversation-checkpoint-item-head">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-pressed={selected}
                  onClick={() => setSelectedRunId(group.run.id)}
                >
                  <span className="conversation-checkpoint-ordinal">#{group.run.ordinal}</span>
                  <span className="my-item-title truncate">{group.promptPreview}</span>
                </button>
                <span className="conversation-checkpoint-status" data-status={status}>{statusLabel}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-my-xs text-my-tertiary">
                <span className="tabular-nums">
                  {timestamp ? `${timestamp} · ` : ''}
                  {group.before?.status === 'captured' && group.after?.status === 'captured'
                    ? '执行前/后双快照'
                    : group.before?.status === 'captured'
                      ? '仅执行前快照'
                      : group.after?.status === 'captured'
                        ? '仅执行后快照'
                        : summary?.detail || '无可用文件快照'}
                </span>
                {canRollback && onRollbackRun && (
                  <div className="inline-flex items-center gap-1">
                    {group.before && (
                      <Button size="sm" variant="ghost" onClick={() => onRollbackRun(group.run.id, 'before')}>
                        <RotateCcw size={12} aria-hidden="true" />
                        回滚至此轮前
                      </Button>
                    )}
                    {group.after && (
                      <Button size="sm" variant="ghost" onClick={() => onRollbackRun(group.run.id, 'after')}>
                        <RotateCcw size={12} aria-hidden="true" />
                        回滚至此轮后
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {activeDiff && (
        <section className="conversation-project-card" aria-label="本轮文件差异详情">
          <div className="conversation-project-toolbar">
            <h3 className="my-item-title">
              第 #{activeGroup?.run.ordinal} 轮文件变更
            </h3>
            {activeDiff.result && (
              <span className="my-item-description tabular-nums">
                {activeDiff.result.files.length} 个文件
              </span>
            )}
          </div>
          {activeDiff.loading && <p className="my-item-description" role="status">正在计算检查点文件差异…</p>}
          {activeDiff.error && (
            <FeedbackNotice variant="bar-compact" tone="warning" title="无法读取检查点差异" description={activeDiff.error} />
          )}
          {activeDiff.result && activeDiff.result.files.length === 0 && (
            <p className="my-item-description">本轮执行未产生工作区文件变更。</p>
          )}
          {activeDiff.result && activeDiff.result.files.length > 0 && (
            <>
              <ul className="conversation-checkpoint-files" aria-label="改动文件清单">
                {activeDiff.result.files.map((file) => (
                  <li key={`${file.status}:${file.path}`}>
                    <button
                      type="button"
                      className="conversation-checkpoint-file-btn"
                      disabled={!projectAvailable || !onOpenSurface || file.status === 'deleted'}
                      title={file.path}
                      onClick={() => onOpenSurface?.(conversationFileSurface(file.path))}
                    >
                      <span className="conversation-checkpoint-file-status" data-kind={file.status}>
                        {FILE_STATUS_BADGE[file.status]}
                      </span>
                      <FileCode size={13} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{file.path}</span>
                      <span className="conversation-project-stats">
                        <span>+{file.additions}</span>
                        <span>−{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <UnifiedDiff
                value={{
                  diff: activeDiff.result.diff,
                  added: totalAdded,
                  removed: totalRemoved,
                  binary: false,
                  truncated: activeDiff.result.truncated,
                }}
              />
            </>
          )}
        </section>
      )}
    </div>
  )
}
