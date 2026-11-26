import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

// 模块级会话内存快照与本次进程重验标记：支持跨路由/多项目 0ms 瞬时水合，同时保证每次会话至少静默向后端重验一次。
const retainedLists = new Map<string, CatalogRead>()
const retainedReads = new Map<string, DescriptorRead>()
const revalidatedLists = new Set<string>()
const revalidatedReads = new Set<string>()

const STORAGE_PREFIX = 'crux.conversation.catalog.v1:'
const STORAGE_INDEX_KEY = 'crux.conversation.catalog.v1:__index'
const STORAGE_TTL_MS = 24 * 60 * 60_000
const STORAGE_MAX_SCOPES = 12
const PROVISIONAL_RETRY_DELAYS_MS = [900, 2200, 4500] as const

interface PersistedCatalogSnapshot {
  readonly cachedAt: number
  readonly drivers?: DriverList
  readonly descriptors?: Record<string, ConversationDriverDescriptor>
}

function readPersistedCatalog(scopeKey: string): PersistedCatalogSnapshot | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + scopeKey)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<PersistedCatalogSnapshot> | null
    if (!parsed || typeof parsed.cachedAt !== 'number' || Date.now() - parsed.cachedAt >= STORAGE_TTL_MS) return undefined
    const validDescriptors: Record<string, ConversationDriverDescriptor> = {}
    if (parsed.descriptors && typeof parsed.descriptors === 'object') {
      for (const [id, desc] of Object.entries(parsed.descriptors)) {
        // 过滤任何历史误落盘的静态兜底目录（仅含 3 个内置模型且无 skills 的早期快照或 provisional 快照）
        const looksLikeLegacyFallback = !desc?.skills && desc?.actions?.chat?.detail?.includes('已加载内置默认模型目录')
        if (desc && !desc.provisional && !looksLikeLegacyFallback) validDescriptors[id] = desc
      }
    }
    return {
      cachedAt: parsed.cachedAt,
      ...(Array.isArray(parsed.drivers) ? { drivers: parsed.drivers } : {}),
      descriptors: validDescriptors,
    }
  } catch {
    return undefined
  }
}

function updateStorageIndex(scopeKey: string): void {
  const indexRaw = localStorage.getItem(STORAGE_INDEX_KEY)
  const parsed = JSON.parse(indexRaw ?? '[]') as unknown
  const index: string[] = Array.isArray(parsed) ? (parsed as string[]) : []
  const updated = [scopeKey, ...index.filter(item => item !== scopeKey)]
  while (updated.length > STORAGE_MAX_SCOPES) {
    const evicted = updated.pop()
    if (evicted) localStorage.removeItem(STORAGE_PREFIX + evicted)
  }
  localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(updated))
}

function writePersistedCatalog(scopeKey: string, patch: { drivers?: DriverList | null; descriptor?: { instanceId: string; value: ConversationDriverDescriptor | null } }): void {
  try {
    const existing = readPersistedCatalog(scopeKey)
    const descriptors: Record<string, ConversationDriverDescriptor> = { ...(existing?.descriptors ?? {}) }
    if (patch.descriptor) {
      if (patch.descriptor.value && !patch.descriptor.value.provisional) {
        descriptors[patch.descriptor.instanceId] = patch.descriptor.value
      } else {
        delete descriptors[patch.descriptor.instanceId]
      }
    }
    const drivers = patch.drivers === null ? undefined : (patch.drivers ?? existing?.drivers)
    if (!drivers && Object.keys(descriptors).length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + scopeKey)
      return
    }
    const next: PersistedCatalogSnapshot = { cachedAt: Date.now(), ...(drivers ? { drivers } : {}), descriptors }
    localStorage.setItem(STORAGE_PREFIX + scopeKey, JSON.stringify(next))
    updateStorageIndex(scopeKey)
  } catch { /* localStorage 配额或隐私模式异常不影响主流程 */ }
}

function hydrateScopeList(scopeKey: string): CatalogRead | undefined {
  const inMem = retainedLists.get(scopeKey)
  if (inMem?.status === 'ready') return inMem
  const persisted = readPersistedCatalog(scopeKey)
  if (!persisted?.drivers?.length) return undefined
  const hydrated: CatalogRead = { status: 'ready', drivers: persisted.drivers }
  retainedLists.set(scopeKey, hydrated)
  return hydrated
}

function hydrateInstanceRead(scopeKey: string, instanceId: string): DescriptorRead | undefined {
  const readKey = JSON.stringify([scopeKey, instanceId])
  const inMem = retainedReads.get(readKey)
  if (inMem?.status === 'ready') return inMem
  const descriptor = readPersistedCatalog(scopeKey)?.descriptors?.[instanceId]
  if (!descriptor) return undefined
  const hydrated: DescriptorRead = { status: 'ready', descriptor }
  retainedReads.set(readKey, hydrated)
  return hydrated
}

export function useConversationModelCatalog(root: string, interactive: boolean, scopeKey?: string, task?: ConversationTaskLocator, source?: CatalogSource) {
  const key = JSON.stringify([scopeKey, projectRootKey(root) ?? root, task ?? null])
  const [listByScope, setLists] = useState<ReadonlyMap<string, CatalogRead>>(() => {
    if (source) return new Map()
    const hydrated = hydrateScopeList(key)
    return hydrated ? new Map([[key, hydrated]]) : new Map()
  })
  const [reads, setReads] = useState<ReadonlyMap<string, DescriptorRead>>(() => new Map())
  const listByScopeRef = useRef(listByScope)
  listByScopeRef.current = listByScope
  const readsRef = useRef(reads)
  readsRef.current = reads
  const pending = useRef(new Set<string>())
  const provisionalAttempts = useRef(new Map<string, number>())
  const provisionalTimers = useRef(new Map<string, number>())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const timer of provisionalTimers.current.values()) window.clearTimeout(timer)
      provisionalTimers.current.clear()
    }
  }, [key])

  const list = listByScope.get(key) ?? (!source ? hydrateScopeList(key) : undefined)

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (!interactive || pending.current.has(key)) return
    const currentList = listByScopeRef.current.get(key) ?? (!source ? hydrateScopeList(key) : undefined)
    if (!force && currentList?.status === 'ready' && (source || revalidatedLists.has(key))) return
    pending.current.add(key)
    const request = Symbol()
    const keepVisible = !force && currentList?.status === 'ready'
    if (!keepVisible) {
      setLists((previous) => {
        const current = previous.get(key) ?? (!source ? hydrateScopeList(key) : undefined)
        return new Map(previous).set(key, { status: 'loading', request,
          previousDrivers: current?.status === 'ready' ? current.drivers : undefined })
      })
    }
    let next: CatalogRead
    try {
      const result = await (source ? source.list() : api.conversationDrivers(root, task))
      next = result.ok ? { status: 'ready', drivers: result.drivers } : { status: 'failed', error: normalizeFeedbackDiagnostic(result.error) }
    } catch (error) {
      next = { status: 'failed', error: normalizeFeedbackDiagnostic(conversationError(error)) }
    } finally {
      pending.current.delete(key)
    }
    if (!source) {
      if (next.status === 'ready') {
        revalidatedLists.add(key)
        retainedLists.set(key, next)
        writePersistedCatalog(key, { drivers: next.drivers })
      } else {
        revalidatedLists.delete(key)
        retainedLists.delete(key)
        writePersistedCatalog(key, { drivers: null })
      }
    }
    if (!mountedRef.current) return
    setLists((previous) => {
      const current = previous.get(key)
      if (!keepVisible) {
        return current?.status === 'loading' && current.request === request ? new Map(previous).set(key, next) : previous
      }
      return new Map(previous).set(key, next)
    })
  }, [interactive, key, root, task, source])

  const ensure = useCallback(async (instanceId: string, force = false): Promise<void> => {
    const readKey = JSON.stringify([key, instanceId])
    const current = readsRef.current.get(readKey) ?? (!source ? hydrateInstanceRead(key, instanceId) : undefined)
    const isAuthoritative = current?.status === 'ready' && !current.descriptor.provisional && (Boolean(source) || revalidatedReads.has(readKey))
    if (!interactive || pending.current.has(readKey) || current?.status === 'loading' || (!force && isAuthoritative)) return
    const existingTimer = provisionalTimers.current.get(readKey)
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer)
      provisionalTimers.current.delete(readKey)
    }
    pending.current.add(readKey)
    const keepVisible = !force && current?.status === 'ready'
    const loading = { status: 'loading', previousSkills: current?.status === 'ready' ? current.descriptor.skills : undefined } as const
    if (!keepVisible) {
      setReads((previous) => new Map(previous).set(readKey, loading))
    }
    let next: DescriptorRead
    try {
      const result = await (source ? source.describe(instanceId) : api.conversationDescribeDriver({ cwd: root, instanceId, ...(task ? { task } : {}) }))
      next = result.ok ? { status: 'ready', descriptor: result.descriptor } : { status: 'failed', error: normalizeFeedbackDiagnostic(result.error) }
    } catch (error) {
      next = { status: 'failed', error: normalizeFeedbackDiagnostic(conversationError(error)) }
    } finally {
      pending.current.delete(readKey)
    }
    if (!source) {
      if (next.status === 'ready') {
        retainedReads.set(readKey, next)
        if (!next.descriptor.provisional) {
          revalidatedReads.add(readKey)
          provisionalAttempts.current.delete(readKey)
          writePersistedCatalog(key, { descriptor: { instanceId, value: next.descriptor } })
        } else if (mountedRef.current) {
          revalidatedReads.delete(readKey)
          const attempt = provisionalAttempts.current.get(readKey) ?? 0
          if (attempt < PROVISIONAL_RETRY_DELAYS_MS.length) {
            provisionalAttempts.current.set(readKey, attempt + 1)
            const timer = window.setTimeout(() => {
              provisionalTimers.current.delete(readKey)
              if (mountedRef.current) void ensure(instanceId, false)
            }, PROVISIONAL_RETRY_DELAYS_MS[attempt])
            provisionalTimers.current.set(readKey, timer)
          }
        }
      } else {
        revalidatedReads.delete(readKey)
        retainedReads.delete(readKey)
        provisionalAttempts.current.delete(readKey)
        writePersistedCatalog(key, { descriptor: { instanceId, value: null } })
      }
    }
    if (!mountedRef.current) return
    setReads((previous) => {
      if (!keepVisible) return previous.get(readKey) === loading ? new Map(previous).set(readKey, next) : previous
      return new Map(previous).set(readKey, next)
    })
  }, [interactive, key, root, task, source])

  const resolveRead = useCallback((instanceId: string): DescriptorRead | undefined => {
    const readKey = JSON.stringify([key, instanceId])
    return reads.get(readKey) ?? (!source ? hydrateInstanceRead(key, instanceId) : undefined)
  }, [key, reads, source])

  const instances = useMemo<readonly ConversationInstanceCatalog[]>(() => {
    if (list?.status !== 'ready') return []
    return list.drivers.map(driver => ({ ...driver, read: resolveRead(driver.instanceId) }))
  }, [list, resolveRead])
  const models = useMemo<readonly ConversationModelOption[]>(() => instances.flatMap(({ instanceId, driverKind, read }) =>
    read?.status === 'ready' && read.descriptor.actions.chat.state !== 'unsupported'
      ? read.descriptor.models.map(model => ({ ...model, instanceId, driverKind }))
      : [],
  ), [instances])

  const suggestionDrivers = list?.status === 'ready' ? list.drivers : list?.status === 'loading' ? list.previousDrivers : undefined
  const suggestionSkills = !interactive || task || source ? undefined : (instanceId: string) => {
    if (!suggestionDrivers?.some(driver => driver.instanceId === instanceId)) return undefined
    const read = resolveRead(instanceId)
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
