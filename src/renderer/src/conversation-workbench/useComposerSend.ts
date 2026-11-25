import { useCallback, useEffect, useLayoutEffect, useRef, type SetStateAction } from 'react'
import type { ConversationThreadCommandState } from '../../../shared/conversation/command-runtime'
import { isComposerCodeTaskSelection, type ComposerCodeTaskSelection } from '../../../shared/conversation/code-task-action'
import type { ConversationCommandState } from '../../../shared/conversation/desktop'
import type { ProviderOptionSelections } from '../../../shared/conversation/model'
import type { ConversationProjectRoleSelection } from '../../../shared/conversation/project-role'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { conversationHistoryReferenceSchema } from '../../../shared/conversation/thread-relations'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { api } from '../api'
import { normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { useInteractionGuard } from '../utils/interaction-scope'
import type { OptimisticUserMessage } from './optimisticUserMessages'
import type { SideChatInput } from './useSideChat'
import { useComposerAttachments } from './useComposerAttachments'
import {
  CONVERSATION_TEXT_LIMIT, composerDraftKey, emptyDraftContent, hasComposerDraftContent,
  readComposerDraft, updateComposerDraft, useComposerDraft, type ComposerDraftContent, type ComposerReference,
} from './useComposerDraft'

export interface ComposerModel {
  readonly instanceId: string
  readonly id: string
  readonly displayName: string
  readonly options?: ProviderOptionSelections
}

export type ComposerReceipt = (ConversationCommandState | ConversationThreadCommandState) & {
  readonly runId: string
  readonly messageId: string
}

export interface ComposerWorkTaskSelection {
  readonly authority: string
  readonly commandId: string
  readonly authorizationRevision: number
  readonly spaceId: string
  readonly taskId: string
  readonly taskCreatedAt: string
}

interface Submission {
  readonly commandId: string
  readonly root: string
  readonly threadId: string | null
  readonly task?: ConversationTaskLocator
  readonly role?: ConversationProjectRoleSelection
  readonly model: ComposerModel
  readonly message: OptimisticUserMessage
  readonly sourceText: string
  readonly source?: ComposerDraftContent
  readonly draftId?: string
  readonly wireText?: string
  readonly workTask?: ComposerWorkTaskSelection
  readonly codeTask?: ComposerCodeTaskSelection
}

export type ComposerSendState =
  | { phase: 'idle' }
  | { phase: 'submitting'; submission: Submission }
  | { phase: 'accepted'; submission: Submission; receipt: ComposerReceipt }
  | { phase: 'rejected'; submission: Submission; reason: string; restored: boolean }
  | { phase: 'unknown'; submission: Submission; reason: string; checking: boolean }

export interface ComposerDraft extends ComposerDraftContent {
  readonly draftId: string | null
  readonly model: ComposerModel | null
  readonly stash: ComposerDraftContent | null
  readonly state: ComposerSendState
  readonly workTask?: ComposerWorkTaskSelection
  readonly codeTask?: ComposerCodeTaskSelection
}

export interface ComposerSendInput {
  readonly root: string
  readonly threadId: string | null
  readonly scopeKey?: string
  readonly task?: ConversationTaskLocator
  readonly role?: ConversationProjectRoleSelection
  readonly interactive: boolean
  readonly running: boolean
  readonly canSteer: boolean
  readonly onAccepted: (receipt: ComposerReceipt, message: OptimisticUserMessage, workTask?: ComposerWorkTaskSelection,
    codeTask?: ComposerCodeTaskSelection) => void
  readonly onSideChat?: (input: SideChatInput) => Promise<boolean>
  readonly onSideChatError?: (message: string) => void
}

function wasNotAdmitted(failure: IpcFail, commandId: string): boolean {
  if ('commandId' in failure && failure.commandId !== undefined && failure.commandId !== commandId) return false
  if ('outcome' in failure && failure.outcome !== undefined) return failure.outcome === 'not-admitted'
  return failure.code === IpcErrorCode.NoProject || failure.code === IpcErrorCode.InvalidArg
}

function matchesReceipt(
  receipt: ConversationCommandState | ConversationThreadCommandState | null,
  submission: Submission,
): receipt is ComposerReceipt {
  return Boolean(receipt?.runId && receipt.threadId && receipt.commandId === submission.commandId &&
    receipt.messageId === submission.message.id && (!submission.threadId || receipt.threadId === submission.threadId))
}

async function startThreadTurn(submission: Submission, deliveryIntent: 'auto' | 'steer') {
  const { commandId, model, message, root, threadId, task } = submission
  const attachmentIds = submittedContent(submission).attachments.map(attachment => attachment.id)
  const attachments = attachmentIds.length && submission.draftId ? { draftId: submission.draftId, attachmentIds } : {}
  const references = historyReferences(submittedContent(submission))
  const options = model.options?.length ? [...model.options] : undefined
  const text = submission.wireText ?? message.text
  if (!threadId) {
    const titleSeed = submission.sourceText.trim() || submittedContent(submission).attachments[0]?.name || message.text
    const title = Array.from(titleSeed.slice(0, 160)).slice(0, 80).join('').trimEnd()
    return api.conversationCreate({ cwd: root, commandId, messageId: message.id, text,
      title, instanceId: model.instanceId, model: model.id, ...(options ? { options } : {}),
      ...(submission.role ? { role: submission.role } : {}),
      ...(task ? { task } : {}), ...attachments })
  }
  const result = await api.conversationApply({ cwd: root, ...(task ? { task } : {}), command: {
    type: 'message.dispatch', threadId, commandId, messageId: message.id, text,
    instanceId: model.instanceId, model: model.id, deliveryIntent, ...(options ? { options } : {}), ...attachments,
    ...(references.length && { references }),
  } })
  return result.ok ? { ok: true as const, ...result.receipt } : result
}

export function conversationError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function withSubmission(key: string, current: ComposerSendState, update: (draft: ComposerDraft) => ComposerDraft): void {
  updateComposerDraft(key, (draft) => draft.state === current ? update(draft) : draft)
}

function draftContent(draft: ComposerDraftContent): ComposerDraftContent {
  return { text: draft.text, attachments: draft.attachments, references: draft.references }
}

function submittedContent(submission: Submission): ComposerDraftContent {
  return submission.source ?? { ...emptyDraftContent, text: submission.sourceText }
}

function outgoingText(content: ComposerDraftContent): string {
  return [
    ...content.references.flatMap(reference => reference.text
      ? [`${reference.label}\n${reference.text.split(/\r?\n/u).map(line => `> ${line}`).join('\n')}`] : []),
    content.text.trim(),
  ].filter(Boolean).join('\n\n')
}

function historyReferences(content: ComposerDraftContent) {
  return content.references.flatMap(({ threadId, messageIds }) =>
    threadId ? [{ threadId, ...(messageIds?.length && { messageIds: [...messageIds] }) }] : [])
}

export function parseSideChatCommand(text: string): { readonly prompt: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return match ? { prompt: match[1]?.trim() ?? '' } : null
}

export function useComposerSend({
  root, threadId, scopeKey, task, role, interactive, running, canSteer, onAccepted, onSideChat, onSideChatError,
}: ComposerSendInput) {
  const key = composerDraftKey(root, threadId, !threadId && role ? JSON.stringify([scopeKey, 'project-role', role.id]) : scopeKey)
  const currentKey = useRef(key)
  currentKey.current = key
  const canInteract = useInteractionGuard()
  const activeDraft = useComposerDraft(key)
  const attachmentIntake = useComposerAttachments(root, threadId, key, interactive, task)
  const { text: draft, state, model, stash, attachments, references } = activeDraft
  const hasContent = hasComposerDraftContent(activeDraft)
  const outgoingLength = references.length ? outgoingText(activeDraft).length : draft.length

  useLayoutEffect(() => {
    if (!interactive || !canInteract() || state.phase !== 'accepted' || readComposerDraft(key).state !== state) return
    const { receipt, submission } = state
    const remaining = readComposerDraft(key)
    if (!threadId) {
      const promotedKey = composerDraftKey(root, receipt.threadId, scopeKey)
      if (!remaining.attachments.length && hasComposerDraftContent(remaining) && !hasComposerDraftContent(readComposerDraft(promotedKey))) {
        updateComposerDraft(promotedKey, (current) => ({ ...current, ...draftContent(remaining) }))
        withSubmission(key, state, (current) => ({ ...current, ...emptyDraftContent }))
      }
    }
    withSubmission(key, state, (current) => ({
      ...current, state: { phase: 'idle' },
      workTask: submission.workTask?.commandId === current.workTask?.commandId ? undefined : current.workTask,
      codeTask: submission.codeTask?.commandId === current.codeTask?.commandId ? undefined : current.codeTask,
    }))
    onAccepted(receipt, submission.message, submission.workTask, submission.codeTask)
  }, [canInteract, interactive, key, onAccepted, root, scopeKey, state, threadId])

  const checkReceipt = useCallback(async (): Promise<void> => {
    const pending = readComposerDraft(key).state
    if (!interactive || !canInteract() || currentKey.current !== key || pending.phase !== 'unknown' || pending.checking) return
    const { submission } = pending
    const checking = { ...pending, checking: true }
    withSubmission(key, pending, (current) => ({ ...current, state: checking }))
    let reason: string
    try {
      const result = submission.threadId
        ? await api.conversationThreadCommand({ cwd: submission.root, threadId: submission.threadId, commandId: submission.commandId,
          ...(submission.task ? { task: submission.task } : {}) })
        : await api.conversationCommand(submission.commandId, submission.root, submission.task)
      if (result.ok && matchesReceipt(result.receipt, submission)) {
        const { receipt } = result
        if (receipt.dispatch !== 'pending-reconciliation') {
          withSubmission(key, checking, (current) => ({ ...current, state: { phase: 'accepted', submission, receipt } }))
          return
        }
        reason = receipt.detail ?? 'Crux 已记录这条消息，送达仍待核对。'
      } else {
        reason = result.ok ? '暂未查到匹配的受理回执。' : result.error
      }
    } catch (error) {
      reason = conversationError(error)
    }
    withSubmission(key, checking, (current) => ({
      ...current, state: { ...checking, reason: normalizeFeedbackDiagnostic(reason), checking: false },
    }))
  }, [canInteract, interactive, key])

  useEffect(() => {
    void checkReceipt()
  }, [checkReceipt])

  async function send(selection: ComposerModel, options?: { deliveryIntent?: 'auto' | 'steer' }): Promise<void> {
    const current = readComposerDraft(key)
    const text = outgoingText(current)
    const hasAttachments = current.attachments.length > 0
    const references = historyReferences(current)
    const deliveryIntent = options?.deliveryIntent ?? 'auto'
    if (!interactive || !canInteract() || currentKey.current !== key || attachmentIntake.isPending() ||
      (!text && !hasAttachments && !references.length) || (references.length && !threadId) ||
      Math.max(text.length, current.text.length) > CONVERSATION_TEXT_LIMIT ||
      (hasAttachments && (!current.draftId || current.attachments.some(item => item.expiresAt <= Date.now()))) ||
      (current.state.phase !== 'idle' && !(current.state.phase === 'rejected' && current.state.restored))) return
    const side = onSideChat && parseSideChatCommand(current.text)
    if (side && onSideChat) {
      if (hasAttachments || current.references.length) {
        onSideChatError?.('请先打开侧聊，再在侧聊输入框添加附件或引用。')
        return
      }
      if (await onSideChat({ text: side.prompt, selection: {
        instanceId: selection.instanceId, model: selection.id, ...(selection.options?.length && { options: [...selection.options] }),
      } })) {
        updateComposerDraft(key, latest => latest === current ? { ...latest, ...emptyDraftContent } : latest)
      }
      return
    }
    if (deliveryIntent === 'steer' && (!threadId || !running || !canSteer || hasAttachments || references.length || selection.options?.length)) return
    const attachmentOnlyPrompt = '[User attached one or more files without additional text. Respond using the conversation context and the attached files.]'
    const submission: Submission = {
      commandId: crypto.randomUUID(),
      root, threadId, ...(task ? { task: { ...task } } : {}),
      ...(!threadId && role ? { role: { id: role.id, revision: role.revision } } : {}),
      model: selection, sourceText: current.text, source: draftContent(current),
      draftId: current.draftId ?? undefined,
      ...(!threadId && current.workTask ? { workTask: current.workTask } : {}),
      ...(!threadId && isComposerCodeTaskSelection(current.codeTask) ? { codeTask: current.codeTask } : {}),
      wireText: text || (references.length ? '请结合引用的会话内容回复。' : attachmentOnlyPrompt),
      message: { id: crypto.randomUUID(), role: 'user',
        text: text || [...current.attachments.map(item => item.name), ...current.references.map(item => item.label)].join('、'),
        createdAt: new Date().toISOString() },
    }
    const submitting = { phase: 'submitting', submission } as const
    const started = updateComposerDraft(key, (latest) => latest === current
      ? { ...latest, ...emptyDraftContent, state: submitting }
      : latest)
    if (started.state !== submitting) return
    let reason: string
    try {
      const result = await startThreadTurn(submission, deliveryIntent)
      if (result.ok && matchesReceipt(result, submission)) {
        if (result.dispatch !== 'pending-reconciliation') {
          withSubmission(key, submitting, (latest) => ({ ...latest, state: { phase: 'accepted', submission, receipt: result } }))
          return
        }
        reason = result.detail ?? 'Crux 已记录这条消息，送达仍待核对。'
      } else if (!result.ok && wasNotAdmitted(result, submission.commandId)) {
        withSubmission(key, submitting, (latest) => {
          const restored = !hasComposerDraftContent(latest)
          return { ...latest, ...(restored ? submittedContent(submission) : {}),
            state: { phase: 'rejected', submission, reason: normalizeFeedbackDiagnostic(result.error), restored } }
        })
        return
      } else {
        reason = result.ok ? '收到的回执与原发送不匹配。' : result.error
      }
    } catch (error) {
      reason = conversationError(error)
    }
    withSubmission(key, submitting, (latest) => ({
      ...latest, state: { phase: 'unknown', submission,
        reason: normalizeFeedbackDiagnostic(reason || '无法确认发送回执。'), checking: false },
    }))
    void checkReceipt()
  }

  return {
    draft, state, model, stash, attachments, references, hasContent, outgoingLength, draftKey: key, attachmentIntake,
    workTask: activeDraft.workTask, codeTask: activeDraft.codeTask,
    hasSendableContent: Boolean(draft.trim() || attachments.length || references.length),
    readDraft: () => readComposerDraft(key).text,
    async quoteThread(sourceId: string, expectedDraft: string, replacement: string): Promise<boolean> {
      if (!interactive || !canInteract() || currentKey.current !== key || sourceId === threadId) return false
      const result = await api.conversationRead(sourceId, root, task)
      if (!interactive || !canInteract() || currentKey.current !== key) return false
      if (!result.ok) throw new Error(result.error)
      if (result.thread.id !== sourceId) throw new Error('无法核对所选会话。')
      const excerpt = result.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.text.trim())
        .slice(-4).map(message => `${message.role === 'user' ? '用户' : '助手'}：${Array.from(message.text.trim()).slice(0, 800).join('')}`)
        .join('\n\n')
      if (!excerpt) throw new Error('这条会话目前没有可引用的消息。')
      const reference = { id: `thread:${sourceId}`, label: result.thread.title, text: excerpt }
      let applied = false
      updateComposerDraft(key, current => {
        if (current.text !== expectedDraft) return current
        applied = true
        return { ...current, text: replacement, references: current.references.some(item => item.id === reference.id)
          ? current.references : [...current.references, reference] }
      })
      return applied
    },
    setDraft(action: SetStateAction<string>): void {
      if (!interactive || !canInteract() || currentKey.current !== key) return
      updateComposerDraft(key, (current) => {
        const text = typeof action === 'function' ? action(current.text) : action
        return text === current.text ? current : { ...current, text }
      })
    },
    setModel(next: ComposerModel | null): void {
      updateComposerDraft(key, (current) => ({ ...current, model: next }))
    },
    addReference(reference: ComposerReference): void {
      if (!interactive || !canInteract() || currentKey.current !== key) return
      if (reference.threadId) {
        if (!threadId || !conversationHistoryReferenceSchema.safeParse({
          threadId: reference.threadId, ...(reference.messageIds && { messageIds: reference.messageIds }),
        }).success) return
      } else if (!reference.text?.trim()) return
      updateComposerDraft(key, (current) => current.references.some(item => item.id === reference.id) ||
        (reference.threadId && historyReferences(current).length >= 8)
        ? current
        : { ...current, references: [...current.references, reference] })
    },
    removeReference(referenceId: string): void {
      updateComposerDraft(key, (current) => ({
        ...current, references: current.references.filter(item => item.id !== referenceId),
      }))
    },
    stashDraft(): void {
      updateComposerDraft(key, (current) => hasComposerDraftContent(current) && !current.stash
        ? { ...current, ...emptyDraftContent, stash: draftContent(current) }
        : current)
    },
    restoreStash(): void {
      updateComposerDraft(key, (current) => !hasComposerDraftContent(current) && current.stash
        ? { ...current, ...current.stash, stash: null }
        : current)
    },
    restore(stashCurrent = false): void {
      updateComposerDraft(key, (current) => {
        if (current.state.phase !== 'rejected' || current.state.restored || attachmentIntake.isPending()) return current
        const occupied = hasComposerDraftContent(current)
        if (occupied && (!stashCurrent || current.stash)) return current
        return {
          ...current, ...submittedContent(current.state.submission),
          stash: occupied ? draftContent(current) : current.stash,
          state: { ...current.state, restored: true },
        }
      })
    },
    async copyRejectedDraft(): Promise<void> {
      const rejected = readComposerDraft(key).state
      if (!interactive || !canInteract() || rejected.phase !== 'rejected') return
      const source = submittedContent(rejected.submission)
      await navigator.clipboard.writeText(outgoingText(source))
      if (!source.attachments.length && !source.references.length) {
        withSubmission(key, rejected, (current) => ({ ...current, state: { ...rejected, restored: true } }))
      }
    },
    send,
    checkReceipt,
    /** The /side and /btw commands only exist where the host can open a side chat. */
    sideChatAvailable: Boolean(onSideChat),
  }
}
