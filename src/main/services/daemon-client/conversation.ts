/** GUI native facade for the new conversation kernel. */
import type { TrellisApi } from '../../../shared/types'
import type { ConversationCommandState, ConversationEventPage } from '../../../shared/conversation/desktop'
import type { RuntimeBody } from '../../../shared/daemon-runtime'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { runtimeCall } from './runtime'

const failure = (error: unknown): IpcFail => {
  if (error && typeof error === 'object' && 'ok' in error && (error as { ok: unknown }).ok === false) return error as IpcFail
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const known = Object.values(IpcErrorCode).find(value => value === code) ?? IpcErrorCode.Unavailable
  const outcome = error && typeof error === 'object' && 'outcome' in error ? error.outcome : undefined
  return ipcFail(known, error instanceof Error ? error.message : '后台对话内核不可用', outcome === 'unknown' || outcome === 'not-admitted' ? { outcome } : undefined)
}

type CreateInput = Omit<Parameters<TrellisApi['conversationCreate']>[0], 'cwd'>
type ThreadSnapshot = Omit<Exclude<Awaited<ReturnType<TrellisApi['conversationRead']>>, IpcFail>, 'ok'>
export const listConversationModels = async (root: string, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationModels']>>> => {
  try {
    const models = await runtimeCall<unknown, 'runtime.conversationModels'>(root, 'runtime.conversationModels', {}, undefined, isCurrent)
    return { ok: true, models: models as Array<{ id: string; displayName: string; isDefault: boolean }> }
  } catch (error) { return failure(error) }
}

export const createConversationThread = async (root: string, input: CreateInput, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationCreate']>>> => {
  try {
    const result = await runtimeCall<ConversationCommandState, 'runtime.conversationCreate'>(root, 'runtime.conversationCreate', input, input.commandId, isCurrent)
    return { ok: true, ...result }
  } catch (error) { return failure(error) }
}

export const listConversationThreads = async (root: string, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationList']>>> => {
  try {
    const threads = await runtimeCall<unknown, 'runtime.conversationList'>(root, 'runtime.conversationList', {}, undefined, isCurrent)
    return { ok: true, threads: Array.isArray(threads) ? threads : [] }
  } catch (error) { return failure(error) }
}

export const readConversationThread = async (root: string, threadId: string, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationRead']>>> => {
  try {
    const snapshot = await runtimeCall<ThreadSnapshot | null, 'runtime.conversationRead'>(root, 'runtime.conversationRead', { threadId }, undefined, isCurrent)
    if (snapshot === null) return ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程')
    const { thread, messages, runs, asOfSequence } = snapshot
    if (!Number.isSafeInteger(asOfSequence) || asOfSequence < 0) return ipcFail(IpcErrorCode.Io, '会话快照游标无效，请重新加载')
    return { ok: true, thread, messages, runs, asOfSequence }
  } catch (error) { return failure(error) }
}

export const readConversationEvents = async (root: string, input: RuntimeBody<'runtime.conversationEvents'>, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationEvents']>>> => {
  try {
    const page = await runtimeCall<ConversationEventPage | null, 'runtime.conversationEvents'>(root, 'runtime.conversationEvents', input, undefined, isCurrent)
    if (page === null) return ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程')
    return { ok: true, page }
  } catch (error) { return failure(error) }
}

export const readConversationCommand = async (root: string, commandId: string, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationCommand']>>> => {
  try {
    const receipt = await runtimeCall<ConversationCommandState | null, 'runtime.conversationCommand'>(root, 'runtime.conversationCommand', { commandId }, undefined, isCurrent)
    return { ok: true, receipt }
  } catch (error) { return failure(error) }
}
