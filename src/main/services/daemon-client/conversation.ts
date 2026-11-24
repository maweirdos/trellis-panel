/** GUI native facade for the new conversation kernel. */
import type { TrellisApi } from '../../../shared/types'
import type { ConversationCommandState, ConversationEventPage } from '../../../shared/conversation/desktop'
import type { ConversationThreadCommandState, ConversationThreadEventPage, ConversationThreadHistoryPage, ConversationThreadSnapshot } from '../../../shared/conversation/command-runtime'
import type { ConversationDriverDescriptor } from '../../../shared/conversation/driverCatalog'
import type { ConversationAttachmentBytesInput, ConversationAttachmentContent, StagedConversationAttachment } from '../../../shared/conversation/attachments'
import type { OrchestrationV2AppThread } from '../../../shared/conversation/contracts'
import { conversationTaskScopeSchema } from '../../../shared/conversation/task-scope'
import type { NativeConversationTask } from '../../../shared/conversation/task-native'
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

type CreateInput = RuntimeBody<'runtime.conversationCreate'>
export async function readConversationTaskScope(task: NativeConversationTask, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationTaskScope']>>> {
  try {
    const result = await runtimeCall<{ scope: unknown }, 'runtime.conversationTaskScope'>('', 'runtime.conversationTaskScope', task, undefined, isCurrent)
    return { ok: true, scope: conversationTaskScopeSchema.parse(result.scope) }
  } catch (error) { return failure(error) }
}

export const listConversationModels = async (root: string, isCurrent?: () => boolean, task?: NativeConversationTask): Promise<Awaited<ReturnType<TrellisApi['conversationModels']>>> => {
  try {
    const models = await runtimeCall<unknown, 'runtime.conversationModels'>(root, 'runtime.conversationModels', task ? { task } : {}, undefined, isCurrent)
    return { ok: true, models: models as Array<{ id: string; displayName: string; isDefault: boolean }> }
  } catch (error) { return failure(error) }
}

export const createConversationThread = async (root: string, input: CreateInput, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationCreate']>>> => {
  try {
    const result = await runtimeCall<ConversationCommandState, 'runtime.conversationCreate'>(root, 'runtime.conversationCreate', input, input.commandId, isCurrent)
    return { ok: true, ...result }
  } catch (error) { return failure(error) }
}

export const listConversationThreads = async (root: string, isCurrent?: () => boolean, filter: RuntimeBody<'runtime.conversationList'> = {}): Promise<Awaited<ReturnType<TrellisApi['conversationList']>>> => {
  try {
    const threads = await runtimeCall<readonly OrchestrationV2AppThread[], 'runtime.conversationList'>(root, 'runtime.conversationList', filter, undefined, isCurrent)
    return { ok: true, threads }
  } catch (error) { return failure(error) }
}

export const readConversationThread = async (root: string, threadId: string, isCurrent?: () => boolean, task?: NativeConversationTask): Promise<Awaited<ReturnType<TrellisApi['conversationRead']>>> => {
  try {
    const snapshot = await runtimeCall<ConversationThreadSnapshot | null, 'runtime.conversationRead'>(root, 'runtime.conversationRead', { threadId, ...(task && { task }) }, undefined, isCurrent)
    if (snapshot === null) return ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程')
    const { asOfSequence } = snapshot
    if (!Number.isSafeInteger(asOfSequence) || asOfSequence < 0) return ipcFail(IpcErrorCode.Io, '会话快照游标无效，请重新加载')
    return { ok: true, ...snapshot }
  } catch (error) { return failure(error) }
}

export const readConversationEvents = async (root: string, input: RuntimeBody<'runtime.conversationEvents'>, isCurrent?: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationEvents']>>> => {
  try {
    const page = await runtimeCall<ConversationEventPage | null, 'runtime.conversationEvents'>(root, 'runtime.conversationEvents', input, undefined, isCurrent)
    if (page === null) return ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程')
    return { ok: true, page }
  } catch (error) { return failure(error) }
}

export const readConversationCommand = async (root: string, commandId: string, isCurrent?: () => boolean, task?: NativeConversationTask): Promise<Awaited<ReturnType<TrellisApi['conversationCommand']>>> => {
  try {
    const receipt = await runtimeCall<ConversationCommandState | null, 'runtime.conversationCommand'>(root, 'runtime.conversationCommand', { commandId, ...(task && { task }) }, undefined, isCurrent)
    return { ok: true, receipt }
  } catch (error) { return failure(error) }
}

export const applyConversationCommand = async (root: string, input: RuntimeBody<'runtime.conversationApply'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationApply']>>> => {
  const { commandId } = input.command
  try {
    const receipt = await runtimeCall<ConversationThreadCommandState, 'runtime.conversationApply'>(root, 'runtime.conversationApply', input, commandId, isCurrent)
    return { ok: true, receipt }
  } catch (error) {
    const failed = failure(error)
    return ipcFail(failed.code, failed.error, { ...failed, commandId })
  }
}

export const readConversationThreadCommand = async (root: string, input: RuntimeBody<'runtime.conversationThreadCommand'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationThreadCommand']>>> => {
  try {
    const receipt = await runtimeCall<ConversationThreadCommandState | null, 'runtime.conversationThreadCommand'>(root, 'runtime.conversationThreadCommand', input, undefined, isCurrent)
    return { ok: true, receipt }
  } catch (error) { return failure(error) }
}

export const readConversationEventDelta = async (root: string, input: RuntimeBody<'runtime.conversationEventDelta'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationEventDelta']>>> => {
  try {
    const page = await runtimeCall<ConversationThreadEventPage | null, 'runtime.conversationEventDelta'>(root, 'runtime.conversationEventDelta', input, undefined, isCurrent)
    return page === null ? ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程') : { ok: true, page }
  } catch (error) { return failure(error) }
}

export const readConversationHistory = async (root: string, input: RuntimeBody<'runtime.conversationHistory'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationHistory']>>> => {
  try {
    const page = await runtimeCall<ConversationThreadHistoryPage | null, 'runtime.conversationHistory'>(root, 'runtime.conversationHistory', input, undefined, isCurrent)
    return page === null ? ipcFail(IpcErrorCode.NotFound, '会话不存在或不属于当前工程') : { ok: true, page }
  } catch (error) { return failure(error) }
}

type DriverList = Extract<Awaited<ReturnType<TrellisApi['conversationDrivers']>>, { ok: true }>['drivers']
export const listConversationDrivers = async (root: string, isCurrent: () => boolean, task?: NativeConversationTask): Promise<Awaited<ReturnType<TrellisApi['conversationDrivers']>>> => {
  try {
    const drivers = await runtimeCall<DriverList, 'runtime.conversationDrivers'>(root, 'runtime.conversationDrivers', task ? { task } : {}, undefined, isCurrent)
    return { ok: true, drivers }
  } catch (error) { return failure(error) }
}

export const describeConversationDriver = async (root: string, input: RuntimeBody<'runtime.conversationDescribeDriver'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationDescribeDriver']>>> => {
  try {
    const descriptor = await runtimeCall<ConversationDriverDescriptor, 'runtime.conversationDescribeDriver'>(root, 'runtime.conversationDescribeDriver', input, undefined, isCurrent)
    return { ok: true, descriptor }
  } catch (error) { return failure(error) }
}

export async function stageConversationAttachment(root: string, input: RuntimeBody<'runtime.conversationAttachmentList'> & ConversationAttachmentBytesInput, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationAttachmentStage']>>> {
  try {
    const { bytes, ...metadata } = input
    const attachment = await runtimeCall<StagedConversationAttachment, 'runtime.conversationAttachmentStage'>(root, 'runtime.conversationAttachmentStage', {
      ...metadata, data: Buffer.from(bytes).toString('base64'),
    }, undefined, isCurrent)
    return { ok: true, attachment }
  } catch (error) { return failure(error) }
}

export async function listConversationAttachments(root: string, input: RuntimeBody<'runtime.conversationAttachmentList'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationAttachmentList']>>> {
  try {
    const attachments = await runtimeCall<readonly StagedConversationAttachment[], 'runtime.conversationAttachmentList'>(root, 'runtime.conversationAttachmentList', input, undefined, isCurrent)
    return { ok: true, attachments }
  } catch (error) { return failure(error) }
}

export async function releaseConversationAttachment(root: string, input: RuntimeBody<'runtime.conversationAttachmentRelease'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationAttachmentRelease']>>> {
  try {
    const released = await runtimeCall<boolean, 'runtime.conversationAttachmentRelease'>(root, 'runtime.conversationAttachmentRelease', input, undefined, isCurrent)
    return { ok: true, released }
  } catch (error) { return failure(error) }
}

export async function readConversationAttachment(root: string, input: RuntimeBody<'runtime.conversationAttachmentRead'>, isCurrent: () => boolean): Promise<Awaited<ReturnType<TrellisApi['conversationAttachmentRead']>>> {
  try {
    const result = await runtimeCall<(Omit<ConversationAttachmentContent, 'bytes'> & { data: string }) | null, 'runtime.conversationAttachmentRead'>(root, 'runtime.conversationAttachmentRead', input, undefined, isCurrent)
    if (!result) return ipcFail(IpcErrorCode.NotFound, '附件不存在或不属于当前会话。')
    const { data, ...metadata } = result
    return { ok: true, content: { ...metadata, bytes: Buffer.from(data, 'base64') } }
  } catch (error) { return failure(error) }
}
