import { canConfirmTaskClarification } from '@shared/crux'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { useCrux } from '../crux/store'
import { taskActorId } from '../crux/pages/task-detail/use-task-source'
import { Button } from '../my/ui'
import { TaskDescriptionSuggestion } from '../crux/pages/task-detail/TaskDescriptionSuggestion'
import { useTaskDescriptionSuggestion, type TaskDescriptionSuggestionSelection } from '../crux/pages/task-detail/use-task-description-suggestion'
import { editDraft, requestComposerFocus, useConversations } from './workspace'

export interface TaskSuggestionQuote {
  taskId: string
  taskCreatedAt: string
  text: string
  from: number
  to: number
}

export interface TaskSuggestionQuotePort {
  selectQuote(quote: TaskSuggestionQuote): boolean
  selectPolish(selection: Omit<TaskSuggestionQuote, 'taskId' | 'taskCreatedAt'>): boolean
  composerReference?: ReactNode
  onSendMessage?(): Promise<void>
  reviewSlot?: ReactNode
  editorDecoration?: ReactNode
}

/** PrivateWorkspace consumes this narrow port; it never receives the raw private transcript. */
export function useTaskSuggestionPort({ snapshot, task, conversationId, entryKey, canStart }: {
  snapshot: CruxSnapshot | null
  task: CruxTask | null
  conversationId?: string
  entryKey: string
  canStart: boolean
}): TaskSuggestionQuotePort {
  const [selection, setSelection] = useState<{ owner: string; quote: TaskSuggestionQuote; mode: 'quote' | 'polish' } | null>(null)
  const workspace = useCrux(state => state.workspaceContext)
  const actorId = snapshot ? taskActorId(snapshot, workspace) : undefined
  const owner = JSON.stringify([task?.id, task?.createdAt, conversationId, entryKey, workspace.key, workspace.instanceId, workspace.epoch, actorId])
  const reviewing = canStart && selection?.owner === owner ? selection : null
  const quote = reviewing?.mode === 'quote' ? reviewing.quote : null
  useEffect(() => { if (!canStart || selection?.owner !== owner) setSelection(null) }, [owner, canStart, selection?.owner])
  const quotedDescription = quote ? (task?.description ?? '').slice(quote.from, quote.to) : ''
  useEffect(() => { if (quote && quotedDescription !== quote.text) setSelection(null) }, [quote, quotedDescription])
  const conversationLinkedToCurrentTask = Boolean(task?.conversations?.some(link => link.id === conversationId))
  const conversationEntryCurrent = useConversations(state => Boolean(conversationId && state.entries[entryKey]?.conversation?.id === conversationId))
  const linkedActorOwnsTask = Boolean(actorId && conversationId && task?.conversations?.some(link => link.id === conversationId && link.actorId === actorId))
  const canRequest = canStart && conversationLinkedToCurrentTask && conversationEntryCurrent && Boolean(snapshot && task && conversationId && entryKey) && linkedActorOwnsTask && workspace.key !== ''
  const canAdopt = Boolean(canRequest && snapshot && task && canConfirmTaskClarification(snapshot, task, actorId))
  const ready = Boolean(snapshot && task)
  const suggestion = useTaskDescriptionSuggestion({
    snapshot, task, enabled: ready && canRequest,
    port: canRequest && conversationId && actorId ? { conversationId, entryKey, workspaceKey: workspace.key, actorId } : undefined
  })
  const selectQuote = useCallback((value: TaskSuggestionQuote): boolean => {
    if (!snapshot || !task || !canRequest || value.taskId !== task.id || value.taskCreatedAt !== task.createdAt || (task.description ?? '').slice(value.from, value.to) !== value.text) return false
    setSelection({ owner, quote: value, mode: 'quote' })
    requestComposerFocus(entryKey)
    return true
  }, [canRequest, entryKey, snapshot, task, owner])

  const removeQuote = useCallback((): void => setSelection(null), [])
  const submit = useCallback((selection: TaskDescriptionSuggestionSelection, nextInstruction: string): void => {
    if (reviewing && nextInstruction.trim()) void suggestion.start(selection, nextInstruction)
  }, [reviewing, suggestion.start])

  const selectPolish = useCallback((selection: Omit<TaskSuggestionQuote, 'taskId' | 'taskCreatedAt'>): boolean => {
    if (!snapshot || !task || !canRequest || suggestion.busy || suggestion.status === 'running' ||
      (task.description ?? '').slice(selection.from, selection.to) !== selection.text) return false
    const nextQuote: TaskSuggestionQuote = { ...selection, taskId: task.id, taskCreatedAt: task.createdAt }
    setSelection({ owner, quote: nextQuote, mode: 'polish' })
    void suggestion.start(selection, '仅润色选定文本，保留原意、事实、术语和结构。只返回这一段替换文本。')
    return true
  }, [canRequest, owner, snapshot, task, suggestion.busy, suggestion.status, suggestion.start])

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!canRequest || !conversationId || !quote || suggestion.busy) return
    const entry = useConversations.getState().entries[entryKey]
    const authoritativeOwner = entry?.owner
    const instruction = entry?.text.trim() ?? ''
    if (!entry || entry.locked || entry.action || !entry.loaded || !entry.conversation || entry.conversation.id !== conversationId || !instruction) return
    const accepted = await suggestion.start({ text: quote.text, from: quote.from, to: quote.to }, instruction)
    const latest = useConversations.getState().entries[entryKey]
    if (accepted && latest && latest.owner === authoritativeOwner && latest.conversation?.id === conversationId && latest.text === entry.text) editDraft(entryKey, '')
  }, [canRequest, conversationId, entryKey, quote, suggestion])

  return {
    selectQuote,
    selectPolish,
    composerReference: canRequest && quote ? <div className="design-composer-reference my-activity-note">
      <span className="min-w-0 flex-1 truncate" title={quote.text}>{quote.text}</span>
      <Button size="sm" variant="ghost" aria-label="移除任务正文引用" disabled={suggestion.busy} onClick={removeQuote}><X size={13} /></Button>
    </div> : undefined,
    onSendMessage: canRequest && quote ? sendMessage : undefined,
    reviewSlot: reviewing && canRequest && (reviewing.mode === 'quote' || !['adopted', 'closed'].includes(suggestion.status)) ? <TaskDescriptionSuggestion suggestion={suggestion} canAdopt={canAdopt} onSendToAgent={submit} /> : undefined,
    editorDecoration: reviewing?.mode === 'polish' && suggestion.busy && suggestion.status === 'idle'
      ? <p className="task-post-saving" role="status">正在润色选中文字…</p> : undefined
  }
}
