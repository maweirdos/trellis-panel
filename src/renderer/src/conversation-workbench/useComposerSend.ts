import { useCallback, useEffect, useLayoutEffect, type SetStateAction } from 'react'
import { create } from 'zustand'
import type { ConversationCommandReceipt } from '../../../shared/conversation/desktop'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { api } from '../api'
import { projectRootKey } from '../my/navigation'
import type { OptimisticUserMessage } from './optimisticUserMessages'

export interface ComposerModel {
  readonly id: string
  readonly displayName: string
}

type ConversationCreateInput = Parameters<typeof api.conversationCreate>[0]
type ModelSelection = Pick<ConversationCreateInput, 'instanceId' | 'model'>

interface StartThreadTurnInput {
  readonly commandId: string
  readonly message: { readonly messageId: string; readonly role: 'user'; readonly text: string }
  readonly modelSelection?: ModelSelection
  readonly titleSeed?: string
  readonly bootstrap: {
    readonly createThread: { readonly cwd: string; readonly title: string; readonly modelSelection: ModelSelection }
  }
  readonly createdAt: string
}

function startThreadTurn({ input }: { input: StartThreadTurnInput }): ReturnType<typeof api.conversationCreate> {
  const commandId = input.commandId
  const thread = input.bootstrap.createThread
  const launch = {
    commandId,
    title: input.titleSeed ?? thread.title,
    modelSelection: input.modelSelection ?? thread.modelSelection,
    cwd: thread.cwd,
    initialMessage: {
      messageId: input.message.messageId,
      text: input.message.text,
    },
  }

  return api.conversationCreate({
    cwd: launch.cwd,
    commandId: launch.commandId,
    title: launch.title,
    ...launch.modelSelection,
    ...launch.initialMessage,
  })
}

interface Submission {
  readonly commandId: string
  readonly root: string
  readonly model: ComposerModel
  readonly message: OptimisticUserMessage
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'submitting'; submission: Submission }
  | { phase: 'accepted'; submission: Submission; receipt: ConversationCommandReceipt }
  | { phase: 'rejected'; submission: Submission; reason: string }
  | { phase: 'unknown'; submission: Submission; originalReason: string; reason: string; checking: boolean; queried: boolean }

interface ComposerDraft {
  text: string
  state: SendState
}

const EMPTY_DRAFT: ComposerDraft = { text: '', state: { phase: 'idle' } }
const useComposerDrafts = create<{ drafts: ReadonlyMap<string, ComposerDraft> }>(() => ({ drafts: new Map() }))

function readDraft(key: string): ComposerDraft {
  return useComposerDrafts.getState().drafts.get(key) ?? EMPTY_DRAFT
}

function updateDraft(key: string, update: (current: ComposerDraft) => ComposerDraft): void {
  useComposerDrafts.setState((store) => {
    const current = store.drafts.get(key) ?? EMPTY_DRAFT
    const draft = update(current)
    if (draft === current) return store
    const drafts = new Map(store.drafts)
    if (!draft.text && draft.state.phase === 'idle') drafts.delete(key)
    else drafts.set(key, draft)
    return { drafts }
  })
}

function wasNotAdmitted(failure: IpcFail): boolean {
  if ('outcome' in failure && failure.outcome !== undefined) return failure.outcome === 'not-admitted'
  return failure.code === IpcErrorCode.NoProject || failure.code === IpcErrorCode.InvalidArg
}

export function conversationError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useComposerSend(
  root: string,
  interactive: boolean,
  onAccepted: (receipt: ConversationCommandReceipt, message: OptimisticUserMessage) => void,
) {
  const key = projectRootKey(root) ?? root
  const { text: draft, state } = useComposerDrafts((store) => store.drafts.get(key) ?? EMPTY_DRAFT)

  useLayoutEffect(() => {
    if (!interactive || state.phase !== 'accepted' || readDraft(key).state !== state) return
    updateDraft(key, (current) => ({ ...current, state: { phase: 'idle' } }))
    const { receipt, submission } = state
    onAccepted(receipt, { ...submission.message, id: receipt.messageId, createdAt: receipt.acceptedAt })
  }, [interactive, key, onAccepted, state])

  const checkReceipt = useCallback(async (): Promise<void> => {
    const pending = readDraft(key).state
    if (!interactive || pending.phase !== 'unknown' || pending.checking) return
    const { submission, originalReason } = pending
    const setState = (next: SendState): void => updateDraft(key, (current) => ({ ...current, state: next }))
    setState({ ...pending, queried: true, checking: true })

    let reason: string
    try {
      const result = await api.conversationCommand(submission.commandId, submission.root)
      if (result.ok && result.receipt?.commandId === submission.commandId) {
        setState({ phase: 'accepted', submission, receipt: result.receipt })
        return
      }
      reason = result.ok ? `${originalReason} · 暂未查到受理回执` : result.error
    } catch (error) {
      reason = conversationError(error)
    }
    setState({ ...pending, reason, checking: false, queried: true })
  }, [interactive, key])

  useEffect(() => {
    if (state.phase === 'unknown' && !state.queried) void checkReceipt()
  }, [checkReceipt, state])

  async function send(model: ComposerModel): Promise<void> {
    const current = readDraft(key)
    if (!interactive || !current.text.trim() || (current.state.phase !== 'idle' && current.state.phase !== 'rejected')) return
    const sendSnapshot = current.text
    const messageIdForSend = crypto.randomUUID()
    const messageCreatedAt = new Date().toISOString()
    const outgoingMessageText = sendSnapshot.trim()
    const title = outgoingMessageText.slice(0, 80).trimEnd()
    const modelSelection = { instanceId: 'codex', model: model.id }
    const bootstrap = { createThread: { cwd: root, title, modelSelection } }
    const input: StartThreadTurnInput = {
      commandId: crypto.randomUUID(),
      message: {
        messageId: messageIdForSend,
        role: 'user',
        text: outgoingMessageText,
      },
      modelSelection,
      titleSeed: title,
      bootstrap,
      createdAt: messageCreatedAt,
    }
    const optimisticMessage: OptimisticUserMessage = {
      id: input.message.messageId,
      role: input.message.role,
      text: input.message.text,
      createdAt: input.createdAt,
    }
    const submission = {
      commandId: input.commandId,
      root: input.bootstrap.createThread.cwd,
      model,
      message: optimisticMessage,
    }

    updateDraft(key, () => ({ text: '', state: { phase: 'submitting', submission } }))
    const setState = (next: SendState): void => updateDraft(key, (latest) => ({ ...latest, state: next }))
    let reason: string
    try {
      const startPromise = startThreadTurn({ input })
      const result = await startPromise
      if (result.ok && result.commandId === submission.commandId) {
        setState({ phase: 'accepted', submission, receipt: result })
        return
      }
      if (!result.ok && wasNotAdmitted(result)) {
        updateDraft(key, (latest) => ({
          text: latest.text || sendSnapshot,
          state: { phase: 'rejected', submission, reason: result.error },
        }))
        return
      }
      reason = result.ok ? '无法确认发送回执' : result.error
    } catch (error) {
      reason = conversationError(error)
    }
    reason ||= '无法确认发送回执'
    setState({ phase: 'unknown', submission, originalReason: reason, reason, checking: false, queried: false })
  }

  return {
    draft,
    setDraft: (action: SetStateAction<string>) => {
      updateDraft(key, (current) => ({ ...current, text: typeof action === 'function' ? action(current.text) : action }))
    },
    state,
    send,
    checkReceipt: () => void checkReceipt(),
  }
}
