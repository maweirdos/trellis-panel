import { useCallback, useState } from 'react'
import type { ProviderInteractionMode, RuntimeMode } from '../../../shared/conversation/providerPolicy'
import type { ConversationProjectRoleSelection } from '../../../shared/conversation/project-role'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { api } from '../api'
import { conversationError, type ComposerModel } from './useComposerSend'

export const MAX_FANOUT_MODELS = 4

export function fanoutModelKey(model: Pick<ComposerModel, 'instanceId' | 'id'>): string {
  return `${model.instanceId}\u0000${model.id}`
}

export interface FanoutTargetOutcome {
  readonly model: ComposerModel
  readonly ok: boolean
  readonly threadId?: string
  readonly error?: string
}

export interface MultiModelFanoutResult {
  readonly succeeded: readonly { readonly model: ComposerModel; readonly threadId: string }[]
  readonly failed: readonly { readonly model: ComposerModel; readonly error: string }[]
}

export interface MultiModelCreateFn {
  (input: {
    readonly cwd: string
    readonly commandId: string
    readonly messageId: string
    readonly text: string
    readonly title: string
    readonly instanceId: string
    readonly model: string
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    readonly runtimeMode?: RuntimeMode
    readonly interactionMode?: ProviderInteractionMode
    readonly role?: ConversationProjectRoleSelection
    readonly tags?: readonly string[]
    readonly task?: ConversationTaskLocator
  }): Promise<{ readonly ok: true; readonly threadId?: string } | { readonly ok: false; readonly error: string }>
}

function buildFanoutTitle(model: ComposerModel, text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? '多模型对比'
  const seed = Array.from(firstLine.slice(0, 80)).slice(0, 48).join('').trim()
  return `[${model.displayName || model.id}] ${seed || '多模型对比'}`.slice(0, 80)
}

export async function executeMultiModelFanout(input: {
  readonly cwd: string
  readonly text: string
  readonly wireText?: string
  readonly models: readonly ComposerModel[]
  readonly runtimeMode?: RuntimeMode
  readonly interactionMode?: ProviderInteractionMode
  readonly role?: ConversationProjectRoleSelection
  readonly tags?: readonly string[]
  readonly task?: ConversationTaskLocator
  readonly createThread?: MultiModelCreateFn
}): Promise<MultiModelFanoutResult> {
  const createThread: MultiModelCreateFn = input.createThread ?? (async (req) => api.conversationCreate({
    cwd: req.cwd,
    commandId: req.commandId,
    messageId: req.messageId,
    text: req.text,
    title: req.title,
    instanceId: req.instanceId,
    model: req.model,
    ...(req.options?.length ? { options: req.options.map((option) => ({ id: option.id, value: option.value })) } : {}),
    ...(req.runtimeMode ? { runtimeMode: req.runtimeMode } : {}),
    ...(req.interactionMode ? { interactionMode: req.interactionMode } : {}),
    ...(req.role ? { role: req.role } : {}),
    ...(req.tags?.length ? { tags: [...req.tags] } : {}),
    ...(req.task ? { task: req.task } : {}),
  }))

  const dedupedModels: ComposerModel[] = []
  const seen = new Set<string>()
  for (const model of input.models) {
    const key = fanoutModelKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    dedupedModels.push(model)
    if (dedupedModels.length >= MAX_FANOUT_MODELS) break
  }

  const baseTags = Array.from(new Set(['多模型对比', ...(input.tags ?? [])]))
  const outgoing = input.wireText ?? input.text
  const outcomes = await Promise.all<FanoutTargetOutcome>(dedupedModels.map(async (model) => {
    try {
      const commandId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `fanout_${Date.now()}_${Math.random()}`
      const messageId = typeof crypto !== 'undefined' && crypto.randomUUID ? `msg_${crypto.randomUUID()}` : `msg_${Date.now()}_${Math.random()}`
      const response = await createThread({
        cwd: input.cwd,
        commandId,
        messageId,
        text: outgoing,
        title: buildFanoutTitle(model, input.text),
        instanceId: model.instanceId,
        model: model.id,
        ...(model.options?.length ? { options: model.options } : {}),
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.role ? { role: input.role } : {}),
        tags: baseTags,
        ...(input.task ? { task: input.task } : {}),
      })
      if (response.ok && response.threadId) {
        return { model, ok: true, threadId: response.threadId }
      }
      return {
        model,
        ok: false,
        error: response.ok ? '未返回新会话编号。' : response.error,
      }
    } catch (error) {
      return { model, ok: false, error: conversationError(error) }
    }
  }))

  const succeeded = outcomes
    .filter((item): item is FanoutTargetOutcome & { readonly ok: true; readonly threadId: string } => item.ok && Boolean(item.threadId))
    .map((item) => ({ model: item.model, threadId: item.threadId }))
  const failed = outcomes
    .filter((item) => !item.ok)
    .map((item) => ({ model: item.model, error: item.error ?? '创建对比会话失败。' }))

  return { succeeded, failed }
}

export function useMultipleModelSend(input: {
  readonly cwd: string
  readonly runtimeMode?: RuntimeMode
  readonly interactionMode?: ProviderInteractionMode
  readonly role?: ConversationProjectRoleSelection
  readonly tags?: readonly string[]
  readonly task?: ConversationTaskLocator
  readonly wirePrefix?: string
  readonly onClearDraft: () => void
  readonly onOpenThread: (threadId: string) => void
  readonly onRefreshList: () => void
}) {
  const [selectedModels, setSelectedModels] = useState<readonly ComposerModel[]>([])
  const [sending, setSending] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)

  const toggleModel = useCallback((model: ComposerModel): void => {
    setIssue(null)
    setSelectedModels((current) => {
      const key = fanoutModelKey(model)
      if (current.some((item) => fanoutModelKey(item) === key)) {
        return current.filter((item) => fanoutModelKey(item) !== key)
      }
      if (current.length >= MAX_FANOUT_MODELS) return current
      return [...current, model]
    })
  }, [])

  const clearSelection = useCallback((): void => {
    setSelectedModels([])
    setIssue(null)
  }, [])

  const sendToSelected = useCallback(async (promptText: string): Promise<boolean> => {
    const trimmed = promptText.trim()
    if (!trimmed || selectedModels.length < 2 || sending) return false
    setSending(true)
    setIssue(null)
    try {
      const wireText = input.wirePrefix ? `${input.wirePrefix}${trimmed}` : trimmed
      const result = await executeMultiModelFanout({
        cwd: input.cwd,
        text: trimmed,
        wireText,
        models: selectedModels,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        role: input.role,
        tags: input.tags,
        task: input.task,
      })
      if (result.succeeded.length > 0) {
        input.onRefreshList()
        if (result.failed.length === 0) {
          input.onClearDraft()
          setSelectedModels([])
          input.onOpenThread(result.succeeded[0].threadId)
          return true
        }
        // 部分失败：保留失败模型供一键重发，同时提示已成功发起的会话数
        setSelectedModels(result.failed.map((item) => item.model))
        setIssue(
          `已向 ${result.succeeded.length} 个模型发起对比会话；以下模型发送失败（已保留勾选）：`
          + result.failed.map((item) => `${item.model.displayName}（${item.error}）`).join('、'),
        )
        return true
      }
      setIssue(
        '所有对比模型均发送失败：'
        + result.failed.map((item) => `${item.model.displayName}（${item.error}）`).join('、'),
      )
      return false
    } finally {
      setSending(false)
    }
  }, [input, selectedModels, sending])

  return {
    selectedModels,
    sending,
    issue,
    active: selectedModels.length >= 2,
    toggleModel,
    clearSelection,
    sendToSelected,
    dismissIssue: () => setIssue(null),
  }
}
