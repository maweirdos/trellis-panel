import { useCallback, useMemo, useRef, useState } from 'react'
import type { ConversationDriverDescriptor, ConversationDriverModel, ConversationDriverOption, ConversationDriverSkill } from '../../../shared/conversation/driverCatalog'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { api } from '../api'
import { normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { projectRootKey } from '../my/navigation'
import { conversationError, type ComposerModel } from './useComposerSend'

type DescriptorRead =
  | { status: 'loading'; previousSkills?: readonly ConversationDriverSkill[] }
  | { status: 'ready'; descriptor: ConversationDriverDescriptor }
  | { status: 'failed'; error: string }

type DriverList = Extract<Awaited<ReturnType<typeof api.conversationDrivers>>, { ok: true }>['drivers']

type CatalogRead =
  | { status: 'loading'; request: symbol; previousDrivers?: DriverList }
  | { status: 'ready'; drivers: DriverList }
  | { status: 'failed'; error: string }

export interface ConversationModelOption extends ConversationDriverModel, ComposerModel {
  readonly driverKind: string
}

export interface ConversationInstanceCatalog {
  readonly instanceId: string
  readonly driverKind: string
  readonly read?: DescriptorRead
}

type CatalogSource = {
  list(): Promise<Awaited<ReturnType<typeof api.conversationDrivers>>>
  describe(instanceId: string): Promise<Awaited<ReturnType<typeof api.conversationDescribeDriver>>>
}

export function useConversationModelCatalog(root: string, interactive: boolean, scopeKey?: string, task?: ConversationTaskLocator, source?: CatalogSource) {
  const key = JSON.stringify([scopeKey, projectRootKey(root) ?? root, task ?? null])
  const [listByScope, setLists] = useState<ReadonlyMap<string, CatalogRead>>(() => new Map())
  const [reads, setReads] = useState<ReadonlyMap<string, DescriptorRead>>(() => new Map())
  const pending = useRef(new Set<string>())
  const list = listByScope.get(key)

  const refresh = useCallback(async (): Promise<void> => {
    if (!interactive || pending.current.has(key)) return
    pending.current.add(key)
    const request = Symbol()
    setLists((previous) => {
      const current = previous.get(key)
      return new Map(previous).set(key, { status: 'loading', request,
        previousDrivers: current?.status === 'ready' ? current.drivers : undefined })
    })
    let next: CatalogRead
    try {
      const result = await (source ? source.list() : api.conversationDrivers(root, task))
      next = result.ok ? { status: 'ready', drivers: result.drivers } : { status: 'failed', error: normalizeFeedbackDiagnostic(result.error) }
    } catch (error) {
      next = { status: 'failed', error: normalizeFeedbackDiagnostic(conversationError(error)) }
    } finally {
      pending.current.delete(key)
    }
    setLists((previous) => {
      const current = previous.get(key)
      return current?.status === 'loading' && current.request === request ? new Map(previous).set(key, next) : previous
    })
  }, [interactive, key, root, task, source])

  const ensure = useCallback(async (instanceId: string, force = false): Promise<void> => {
    const readKey = JSON.stringify([key, instanceId])
    const current = reads.get(readKey)
    if (!interactive || pending.current.has(readKey) || current?.status === 'loading' || (!force && current)) return
    pending.current.add(readKey)
    const loading = { status: 'loading', previousSkills: current?.status === 'ready' ? current.descriptor.skills : undefined } as const
    setReads((previous) => new Map(previous).set(readKey, loading))
    let next: DescriptorRead
    try {
      const result = await (source ? source.describe(instanceId) : api.conversationDescribeDriver({ cwd: root, instanceId, ...(task ? { task } : {}) }))
      next = result.ok ? { status: 'ready', descriptor: result.descriptor } : { status: 'failed', error: normalizeFeedbackDiagnostic(result.error) }
    } catch (error) {
      next = { status: 'failed', error: normalizeFeedbackDiagnostic(conversationError(error)) }
    } finally {
      pending.current.delete(readKey)
    }
    setReads((previous) => previous.get(readKey) === loading ? new Map(previous).set(readKey, next) : previous)
  }, [interactive, key, reads, root, task, source])

  const instances = useMemo<readonly ConversationInstanceCatalog[]>(() => {
    if (list?.status !== 'ready') return []
    return list.drivers.map(driver => ({ ...driver, read: reads.get(JSON.stringify([key, driver.instanceId])) }))
  }, [key, list, reads])
  const models = useMemo<readonly ConversationModelOption[]>(() => instances.flatMap(({ instanceId, driverKind, read }) =>
    read?.status === 'ready' && read.descriptor.actions.chat.state !== 'unsupported'
      ? read.descriptor.models.map(model => ({ ...model, instanceId, driverKind }))
      : [],
  ), [instances])

  const suggestionDrivers = list?.status === 'ready' ? list.drivers : list?.status === 'loading' ? list.previousDrivers : undefined
  const suggestionSkills = !interactive || task || source ? undefined : (instanceId: string) => {
    if (!suggestionDrivers?.some(driver => driver.instanceId === instanceId)) return undefined
    const read = reads.get(JSON.stringify([key, instanceId]))
    return read?.status === 'ready' ? read.descriptor.skills : read?.status === 'loading' ? read.previousSkills : undefined
  }
  return { status: list?.status ?? 'idle', error: list?.status === 'failed' ? list.error : undefined,
    instances, models, scopeAllowsSkills: !task && !source, suggestionSkills, refresh, ensure } as const
}

export type ConversationModelCatalog = Omit<ReturnType<typeof useConversationModelCatalog>, 'suggestionSkills'> & {
  readonly suggestionSkills?: (instanceId: string) => readonly ConversationDriverSkill[] | undefined
}

export function isSameComposerModel(left: ComposerModel | null, right: ComposerModel): boolean {
  return left?.instanceId === right.instanceId && left.id === right.id
}

export function turnOptionsForModel(descriptor: ConversationDriverDescriptor, model: ComposerModel): readonly ConversationDriverOption[] {
  return descriptor.options.filter(option => option.turnSelectable && (!option.modelId || option.modelId === model.id))
}

export function unavailableModelReason(catalog: ConversationModelCatalog, model: ComposerModel): string | undefined {
  if (catalog.status !== 'ready') return undefined
  const instance = catalog.instances.find(item => item.instanceId === model.instanceId)
  if (!instance) return '选择的引擎实例已不可用。'
  if (instance.read?.status === 'failed') return instance.read.error
  if (instance.read?.status !== 'ready') return undefined
  const { descriptor } = instance.read
  if (descriptor.actions.chat.state === 'unsupported') return descriptor.actions.chat.detail
  if (!descriptor.models.some(item => item.id === model.id)) return '这个模型已不在所选实例的目录中。'
  if (model.options?.length) {
    const options = turnOptionsForModel(descriptor, model)
    if (model.options.some(selected => !options.some(option => option.id === selected.id &&
      option.choices.some(choice => choice.value === selected.value)))) return '此模型的所选参数已不可用，请重新选择。'
  }
  return undefined
}
