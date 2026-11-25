import { useState, useMemo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  RotateCw,
  Plus,
  ChevronDown,
  Zap,
  CheckCircle2,
  XCircle,
  Trash2,
  Pencil,
  Power,
  MoreHorizontal,
  Loader2,
  Server,
  X,
  Search
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Dropdown, DropdownItem, Modal, SignalMeter, Tooltip } from '../my/ui'
import type { ModelItem, ModelProvider, ModelTestResult, AiApiFormat, AiConfig } from '../../../shared/types'
import { errorMessage } from '../../../shared/errors'
import { CopyableError } from '../components/CopyableError'
import { clsx } from 'clsx'
import { ModelItemEditor, ModelProviderEditor } from './settings/ModelEditors'
import { getModelBrand, getProviderVisual } from './settings/model-brands'
import type { ModelSecretAction } from './settings/ModelEditors'
import { modelErrorSummary } from './settings/model-errors'
import './settings/models.css'

export interface ProviderTemplate {
  id: string
  name: string
  group: string
  description: string
  baseUrl: string
  apiFormat: AiApiFormat
}

export const OFFICIAL_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: '官方供应商',
    description: '深度求索 DeepSeek-V3 / R1 推理模型，高性价比',
    baseUrl: 'https://api.deepseek.com',
    apiFormat: 'openai'
  },
  {
    id: 'zhipu',
    name: '智谱 (BigModel)',
    group: '官方供应商',
    description: '智谱 GLM 系列大模型，支持标准 OpenAI 兼容协议',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'openai'
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    group: '官方供应商',
    description: '月之暗面 Kimi 长上下文大模型',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiFormat: 'openai'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: '官方供应商',
    description: 'GPT-4o, GPT-4o-mini 等官方大语言模型',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai'
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    group: '官方供应商',
    description: '本地运行的开源大模型服务，无需公网与 API Key',
    baseUrl: 'http://localhost:11434',
    apiFormat: 'ollama'
  }
]

function getProviderStatus(p: ModelProvider, isTesting: boolean, result?: ConnectionResult) {
  if (isTesting) {
    return {
      dotClass: 'bg-my-info animate-pulse',
      label: '测试中…',
      tooltip: '正在测试地址是否可达'
    }
  }
  if (result?.ok) {
    return {
      dotClass: 'bg-my-success',
      label: `${p.enabled ? '' : '已停用 · '}地址可达${result.latencyMs === undefined ? '' : ` ${result.latencyMs}ms`}`,
      tooltip: '地址可达不代表凭据有效或模型、目录可用'
    }
  }
  if (result?.ok === false) {
    return {
      dotClass: 'bg-my-danger',
      label: `${p.enabled ? '' : '已停用 · '}地址不可达`,
      tooltip: '地址连通性测试失败，请查看错误详情'
    }
  }
  if (!p.enabled) {
    return {
      dotClass: 'bg-my-layer-3',
      label: '已停用',
      tooltip: '该供应商已停用'
    }
  }
  if (!p.baseUrl.trim()) {
    return {
      dotClass: 'border border-my-line-strong bg-transparent',
      label: '未配置地址',
      tooltip: '尚未填写接口地址'
    }
  }
  return {
    dotClass: 'bg-my-warning',
    label: '待测试',
    tooltip: '配置尚未进行连通性测试'
  }
}

export const DEFAULT_INITIAL_PROVIDER: ModelProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  group: '官方供应商',
  baseUrl: 'https://api.deepseek.com',
  apiFormat: 'openai',
  apiKey: '',
  enabled: true,
  models: [],
  status: 'untested'
}

export function isUnconfiguredDeepseek(provider: ModelProvider): boolean {
  return (
    provider.id === 'deepseek' &&
    !provider.apiKey?.trim() &&
    !provider.apiKeyEncrypted &&
    (!provider.models || provider.models.length === 0)
  )
}

function reconcileProviders(saved: ModelProvider[]): ModelProvider[] {
  return saved.map((provider) => ({
    ...provider,
    group: provider.group || (OFFICIAL_TEMPLATES.some((template) => template.id === provider.id) ? '官方供应商' : '自定义供应商'),
    status: provider.status || 'untested',
    models: provider.models ?? []
  }))
}

function legacyProviderDraft(ai: AiConfig | undefined): ModelProvider | null {
  if (!ai || ai.providers?.length) return null
  const customEndpoint = ai.baseUrl.trim() && ai.baseUrl.trim() !== 'http://localhost:11434/v1'
  if (!(customEndpoint || ai.enabled || ai.model.trim() || ai.apiKey.trim() || ai.apiKeyEncrypted)) return null
  return {
    // Preserve Pi's existing fallback identity and the exact stored secret envelope.
    id: ai.activeProviderId || 'default',
    name: '现有配置',
    group: '自定义供应商',
    enabled: ai.enabled,
    baseUrl: ai.baseUrl,
    apiFormat: ai.apiFormat ?? 'openai',
    apiKey: ai.apiKey,
    apiKeyEncrypted: ai.apiKeyEncrypted,
    models: ai.model.trim() ? [{ id: ai.model, name: ai.model, enabled: true }] : [],
    status: 'untested'
  }
}


function readProviders(ai: AiConfig | undefined): ModelProvider[] {
  if (ai?.providers?.length) {
    return reconcileProviders(ai.providers).filter((p) => !isUnconfiguredDeepseek(p))
  }
  const legacy = legacyProviderDraft(ai)
  if (legacy) return [legacy]
  return []
}

// Used only in memory to retain request ownership; never rendered or logged.
function connectionSource(provider: ModelProvider): string {
  return JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey, Boolean(provider.apiKeyEncrypted)])
}

type ProviderSource = { id: string; source: string; generation: number }
type ConnectionResult = Awaited<ReturnType<typeof api.aiTestConnection>>
type ProviderRequestMode = 'test' | 'fetch'
type CatalogResult = { models?: ModelItem[] }
type ProviderError = { mode: ProviderRequestMode; message: string; catalog?: CatalogResult }
type RequestTicket = { id: symbol; viewGeneration: number }
type ModelInstance = { generation: number; present: boolean; testKeys: Set<string> }

function endpointLabel(value: string): string {
  if (!value.trim()) return '未配置接口地址'
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch { return '自定义接口地址' }
}

export function ModelsPage(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const pushToast = useApp((state) => state.pushToast)
  const providers = useMemo(() => readProviders(settings?.ai), [settings?.ai])
  const activeProviderId = useMemo(() => {
    const configuredId = settings?.ai?.activeProviderId
    if (configuredId && providers.some((provider) => provider.id === configuredId)) {
      return configuredId
    }
    return providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id ?? ''
  }, [settings?.ai?.activeProviderId, providers])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [openErrorModelId, setOpenErrorModelId] = useState<string | null>(null)
  const toggleGroup = (groupName: string): void => {
    setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }))
  }
  const [selectedModel, setSelectedModel] = useState<{ providerId: string; modelId: string } | null>(null)
  type ModelCategory = 'all' | 'enabled' | 'chat' | 'code'
  const [categoryFilter, setCategoryFilter] = useState<ModelCategory>('all')
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelToolbarRef = useRef<HTMLDivElement>(null)
  const selectedProvider = providers.find((provider) => provider.id === selectedId)
    ?? providers.find((provider) => provider.id === activeProviderId)
    ?? providers[0]
  const viewOwner = useRef<{ id: string | undefined; generation: number }>({ id: selectedProvider?.id, generation: 0 })
  if (viewOwner.current.id !== selectedProvider?.id) {
    viewOwner.current = { id: selectedProvider?.id, generation: viewOwner.current.generation + 1 }
  }
  const modelViewRef = useRef({ providerId: selectedProvider?.id, search: modelSearch })
  modelViewRef.current = { providerId: selectedProvider?.id, search: modelSearch }
  const filteredModels = useMemo(() => {
    const terms = modelSearch.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return (selectedProvider?.models ?? []).filter((model) => {
      if (categoryFilter === 'enabled' && !model.enabled) return false
      if (categoryFilter === 'chat') {
        const isChat = !model.tags?.includes('代码') || model.tags?.includes('对话') || model.id.includes('chat') || model.id.includes('gpt')
        if (!isChat) return false
      }
      if (categoryFilter === 'code') {
        const isCode = model.tags?.includes('代码') || model.id.includes('code') || model.id.includes('coder')
        if (!isCode) return false
      }
      const text = [model.name, model.id, model.contextWindow, ...(model.tags || [])].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase()
      return terms.every((term) => text.includes(term))
    })
  }, [selectedProvider, modelSearch, categoryFilter])

  const groupedModels = useMemo(() => {
    const map = new Map<string, ModelItem[]>()
    for (const model of filteredModels) {
      const brand = getModelBrand(model.id, model.name)
      const group = brand.groupName || '其他模型'
      const list = map.get(group) || []
      list.push(model)
      map.set(group, list)
    }
    return Array.from(map.entries()).map(([name, items]) => ({ name, models: items }))
  }, [filteredModels])
  const [showTemplates, setShowTemplates] = useState(false)
  const [providerEditor, setProviderEditor] = useState<{ provider: ModelProvider; source: ProviderSource | null } | null>(null)
  const [modelEditor, setModelEditor] = useState<{ provider: ModelProvider; source: ProviderSource; model: ModelItem; isNew: boolean } | null>(null)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [providerRequests, setProviderRequests] = useState<Record<string, RequestTicket & { mode: ProviderRequestMode }>>({})
  const [modelRequests, setModelRequests] = useState<Record<string, RequestTicket>>({})
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({})
  const [providerResults, setProviderResults] = useState<Record<string, ConnectionResult>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, ProviderError>>({})
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const mounted = useRef(true)
  const sources = useRef(new Map<string, { source: string; generation: number }>())
  const modelInstances = useRef(new Map<string, ModelInstance>())
  const requests = useRef(new Map<string, RequestTicket>())
  const saving = pendingWrites > 0

  useLayoutEffect(() => {
    const toolbar = modelToolbarRef.current
    const container = toolbar?.closest<HTMLElement>('.model-provider-detail')
    if (!toolbar || !container) return
    const measure = (): void => container.style.setProperty('--model-toolbar-height', `${toolbar.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    return () => { observer.disconnect(); container.style.removeProperty('--model-toolbar-height') }
  }, [selectedProvider?.id, Boolean(settings)])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // 自动清理持久化存储中历史遗留的未配置 DeepSeek 幽灵占位符，避免在仅有自定义供应商时干扰显示
  useEffect(() => {
    const rawProviders = settings?.ai?.providers
    if (!rawProviders || !rawProviders.length) return
    const ghost = rawProviders.some(isUnconfiguredDeepseek)
    const activeIsGhost = settings?.ai?.activeProviderId === 'deepseek' && ghost
    if (ghost || activeIsGhost) {
      const cleaned = rawProviders.filter((p) => !isUnconfiguredDeepseek(p))
      const fallbackActive = cleaned.find((p) => p.enabled)?.id ?? cleaned[0]?.id ?? ''
      const nextActive = activeIsGhost ? fallbackActive : (settings.ai?.activeProviderId || fallbackActive)
      void saveSettings({
        ai: {
          ...settings.ai,
          providers: cleaned,
          activeProviderId: nextActive,
          model: settings.ai?.model ?? '',
          baseUrl: settings.ai?.baseUrl ?? '',
          apiKey: settings.ai?.apiKey ?? '',
          temperature: settings.ai?.temperature ?? 0.3
        }
      })
    }
  }, [settings?.ai, saveSettings])
  useEffect(() => {
    setSelectedModel((selection) => selection && !providers.some((provider) => provider.id === selection.providerId && provider.models.some((model) => model.id === selection.modelId)) ? null : selection)
  }, [providers])

  const latestProviders = (): ModelProvider[] => readProviders(useApp.getState().settings?.ai)
  const modelInstanceKey = (providerId: string, modelId: string): string => JSON.stringify([providerId, modelId])
  const getModelInstance = (providerId: string, modelId: string): ModelInstance => {
    const key = modelInstanceKey(providerId, modelId)
    let instance = modelInstances.current.get(key)
    if (!instance) {
      instance = { generation: 0, present: true, testKeys: new Set() }
      modelInstances.current.set(key, instance)
    }
    return instance
  }
  const invalidateModelInstance = (instance: ModelInstance): void => {
    instance.generation += 1
    const keys = [...instance.testKeys]
    instance.testKeys.clear()
    for (const key of keys) requests.current.delete(key)
    if (!keys.length || !mounted.current) return
    setModelRequests((current) => { const next = { ...current }; for (const key of keys) delete next[key]; return next })
    setTestResults((current) => { const next = { ...current }; for (const key of keys) delete next[key]; return next })
  }
  const observeModelInstances = (current: ModelProvider[]): void => {
    const present = new Set<string>()
    for (const provider of current) {
      for (const model of provider.models) {
        present.add(modelInstanceKey(provider.id, model.id))
        getModelInstance(provider.id, model.id).present = true
      }
    }
    for (const [key, instance] of modelInstances.current) {
      if (instance.present && !present.has(key)) {
        instance.present = false
        invalidateModelInstance(instance)
      }
    }
    if (mounted.current) setSelectedModel((selection) => selection && !present.has(modelInstanceKey(selection.providerId, selection.modelId)) ? null : selection)
  }
  const captureSource = (provider: ModelProvider): ProviderSource => {
    const source = connectionSource(provider)
    const previous = sources.current.get(provider.id)
    const generation = previous ? previous.generation + (previous.source === source ? 0 : 1) : 0
    sources.current.set(provider.id, { source, generation })
    return { id: provider.id, source, generation }
  }
  const observeSources = (current: ModelProvider[]): void => {
    for (const provider of current) captureSource(provider)
    for (const [id, value] of sources.current) {
      if (!current.some((provider) => provider.id === id) && value.source) {
        sources.current.set(id, { source: '', generation: value.generation + 1 })
      }
    }
  }
  // Observe each committed inventory so an edit or removal followed by a
  // re-addition cannot be hidden by React batching.
  useEffect(() => {
    const observe = (current: ModelProvider[]): void => {
      observeSources(current)
      observeModelInstances(current)
    }
    observe(latestProviders())
    return useApp.subscribe((state, previous) => {
      if (state.settings?.ai !== previous.settings?.ai) {
        observe(readProviders(state.settings?.ai))
      }
    })
  }, [])

  const ownsSource = (owner: ProviderSource): boolean => {
    if (!mounted.current) return false
    const provider = latestProviders().find((item) => item.id === owner.id)
    if (!provider) return false
    const current = captureSource(provider)
    return current.generation === owner.generation
  }
  const modelResultKey = (owner: ProviderSource, modelId: string): string => JSON.stringify(['model', owner.id, owner.generation, modelId, getModelInstance(owner.id, modelId).generation])
  const providerResultKey = (owner: ProviderSource): string => JSON.stringify(['provider', owner.id, owner.generation])
  const providerErrorKey = (key: string, mode: ProviderRequestMode): string => JSON.stringify([key, mode])
  const ownsView = (providerId: string, generation: number): boolean =>
    mounted.current && viewOwner.current.id === providerId && viewOwner.current.generation === generation
  const beginRequest = (key: string): RequestTicket | null => {
    const generation = viewOwner.current.generation
    if (requests.current.get(key)?.viewGeneration === generation) return null
    const ticket = { id: Symbol(), viewGeneration: generation }
    requests.current.set(key, ticket)
    return ticket
  }
  const ownsRequest = (key: string, ticket: RequestTicket): boolean => requests.current.get(key)?.id === ticket.id
  const selectProvider = (id: string): void => {
    if (viewOwner.current.id !== id) {
      viewOwner.current = { id, generation: viewOwner.current.generation + 1 }
    }
    setSelectedId(id)
    setModelSearch('')
    setOpenErrorModelId(null)
  }

  // Serialize functional updates against the latest encrypted settings returned by IPC.
  // Failed writes leave the saved overview and all open drafts intact.
  const write = (operation: () => Promise<void>): Promise<void> => {
    setPendingWrites((value) => value + 1)
    const job = writeQueue.current.then(operation)
    writeQueue.current = job.catch(() => undefined)
    return job.finally(() => { if (mounted.current) setPendingWrites((value) => value - 1) })
  }
  const persistProviders = (mutate: (current: ModelProvider[]) => ModelProvider[] | null, nextActiveId?: string): Promise<void> => write(async () => {
    const ai = useApp.getState().settings?.ai
    if (!ai) throw new Error('设置尚未加载，请稍后重试')
    const next = mutate(readProviders(ai))
    if (!next) return
    const previousSources = new Map(sources.current)
    const retainedId = nextActiveId ?? ai.activeProviderId ?? legacyProviderDraft(ai)?.id ?? ''
    const active = next.find((provider) => provider.id === retainedId) || next.find((provider) => provider.enabled) || next[0]
    const activeModel = active?.models.find((model) => model.id === ai.model && model.enabled)?.id || active?.models.find((model) => model.enabled)?.id || active?.models[0]?.id || ''
    await saveSettings({ ai: {
      ...ai, enabled: active?.enabled ?? false, baseUrl: active?.baseUrl ?? '',
      apiKey: active?.apiKey ?? '', apiKeyEncrypted: active?.apiKeyEncrypted ?? false,
      model: activeModel, activeProviderId: active?.id ?? '',
      apiFormat: active?.apiFormat ?? ai.apiFormat ?? 'openai', providers: next
    } })
    for (const provider of latestProviders()) {
      const submitted = next.find((item) => item.id === provider.id)
      const previous = previousSources.get(provider.id)
      const observed = sources.current.get(provider.id)
      // IPC may encrypt an unchanged plaintext key on its first write. This is
      // the same connection, so retain request/draft ownership and test feedback.
      if (submitted && previous?.source === connectionSource(submitted) &&
        observed?.source === connectionSource(provider) && observed.generation === previous.generation + 1 &&
        !submitted.apiKeyEncrypted && provider.apiKeyEncrypted &&
        submitted.baseUrl === provider.baseUrl && submitted.apiFormat === provider.apiFormat) {
        sources.current.set(provider.id, { source: connectionSource(provider), generation: previous.generation })
      } else captureSource(provider)
    }
  })
  const reportFailure = (title: string, err: unknown): void => pushToast({ kind: 'error', title, body: errorMessage(err) })
  const runAction = (action: Promise<void>, title = '保存失败'): void => { void action.catch((err) => reportFailure(title, err)) }
  const patchProvider = (id: string, patch: Partial<ModelProvider>): Promise<void> => persistProviders((current) => {
    if (!current.some((provider) => provider.id === id)) throw new Error('该供应商已不存在')
    return current.map((provider) => provider.id === id ? { ...provider, ...patch } : provider)
  })
  const patchModels = (owner: ProviderSource, mutate: (models: ModelItem[]) => ModelItem[]): Promise<void> => persistProviders((current) => {
    if (!ownsSource(owner)) throw new Error('供应商连接配置已更改，请重新打开模型操作')
    return current.map((provider) => provider.id === owner.id ? { ...provider, models: mutate(provider.models) } : provider)
  })
  const handleDeleteModel = (owner: ProviderSource, modelId: string): Promise<void> => {
    if (!ownsSource(owner)) return Promise.reject(new Error('供应商连接配置已更改，请重新打开模型操作'))
    // Retire the current test immediately; a failed delete still cannot revive its result.
    invalidateModelInstance(getModelInstance(owner.id, modelId))
    return patchModels(owner, (models) => models.filter((model) => model.id !== modelId))
  }
  const deleteModelWithFocus = (owner: ProviderSource, modelId: string, origin: HTMLButtonElement): void => {
    const index = filteredModels.findIndex((model) => model.id === modelId)
    const neighborId = filteredModels[index + 1]?.id ?? filteredModels[index - 1]?.id
    const search = modelSearch
    const restore = (id?: string): void => {
      requestAnimationFrame(() => {
        if (!mounted.current || modelViewRef.current.providerId !== owner.id || modelViewRef.current.search !== search) return
        const active = document.activeElement
        if (active !== origin && active !== document.body && active !== document.documentElement) return
        const node = [...document.querySelectorAll<HTMLButtonElement>('.model-provider-detail .model-row-left')].find((item) => item.dataset.modelId === id)
        ;(node ?? modelSearchRef.current)?.focus()
      })
    }
    void handleDeleteModel(owner, modelId).then(() => restore(neighborId)).catch((err) => { reportFailure('删除模型失败', err); restore(modelId) })
  }

  const handleSaveProvider = async (draft: ModelProvider, secretAction: ModelSecretAction): Promise<void> => {
    const editor = providerEditor
    if (!editor) return
    await persistProviders((current) => {
      if (!editor.source) {
        if (current.some((provider) => provider.id === draft.id)) throw new Error('供应商已存在，请重新添加')
        return [...current, draft]
      }
      if (!ownsSource(editor.source)) throw new Error('供应商连接配置已更改，请重新打开配置窗口')
      return current.map((provider) => {
        if (provider.id !== draft.id) return provider
        const candidate = { ...provider, name: draft.name, baseUrl: draft.baseUrl, apiFormat: draft.apiFormat, enabled: draft.enabled,
          ...(secretAction === 'keep' ? {} : { apiKey: draft.apiKey, apiKeyEncrypted: draft.apiKeyEncrypted }) }
        const changed = connectionSource(provider) !== connectionSource(candidate)
        return { ...candidate,
          ...(changed ? { status: 'untested' as const, latencyMs: undefined, lastTestedAt: undefined } : {}) }
      })
    })
    if (!editor.source) { setSelectedId(draft.id); setModelSearch('') }
    pushToast({ kind: 'info', title: editor.source ? '已保存供应商' : '已添加供应商', body: draft.name })
  }

  const handleSelectTemplate = (template: ProviderTemplate | 'custom'): void => {
    const custom = template === 'custom'
    const id = custom ? 'custom' : template.id
    const exists = providers.some((provider) => provider.id === id)
    const newProvider: ModelProvider = {
      id: custom || exists ? `${id}-${crypto.randomUUID()}` : id,
      name: custom ? `自定义供应商 ${providers.length + 1}` : exists ? `${template.name} (${providers.filter((provider) => provider.id.startsWith(id)).length + 1})` : template.name,
      group: custom ? '自定义供应商' : template.group,
      baseUrl: custom ? '' : template.baseUrl,
      apiFormat: custom ? 'openai' : template.apiFormat,
      apiKey: '', enabled: true, models: [], status: 'untested'
    }
    setShowTemplates(false)
    setProviderEditor({ provider: newProvider, source: null })
  }

  const handleDeleteProvider = async (provider: ModelProvider): Promise<void> => {
    const owner = captureSource(provider)
    sources.current.set(owner.id, { source: owner.source, generation: owner.generation + 1 })
    await persistProviders((current) => current.filter((item) => item.id !== provider.id))
    if (selectedId === provider.id) { setSelectedId(null); setModelSearch('') }
    pushToast({ kind: 'info', title: '已删除供应商', body: provider.name })
  }

  const handleProviderRequest = async (provider: ModelProvider, mode: ProviderRequestMode, catalog?: CatalogResult): Promise<void> => {
    const owner = captureSource(provider)
    const key = providerResultKey(owner)
    if (!provider.baseUrl.trim() || viewOwner.current.id !== owner.id) return
    const ticket = beginRequest(key)
    if (!ticket) return
    const ownsOperation = (): boolean => ownsRequest(key, ticket) && ownsSource(owner) && ownsView(owner.id, ticket.viewGeneration)
    const errorKey = providerErrorKey(key, mode)
    setProviderRequests((current) => ({ ...current, [key]: { ...ticket, mode } }))
    setProviderErrors((current) => { const next = { ...current }; delete next[errorKey]; return next })
    if (mode === 'test') setProviderResults((current) => { const next = { ...current }; delete next[key]; return next })
    let catalogToSave = catalog
    try {
      if (mode === 'test') {
        const result = await api.aiTestConnection(provider.baseUrl)
        if (!ownsOperation()) return
        if (!result.ok) throw new Error(result.error || '地址连接失败，请重试')
        setProviderResults((current) => ({ ...current, [key]: result }))
        pushToast({ kind: 'info', title: `${provider.name} 地址可达` })
      } else {
        if (!catalogToSave) {
          const result = await api.aiFetchModels(provider)
          if (!ownsOperation()) return
          if (!result.ok) throw new Error(result.error || '获取模型目录失败，请重试')
          catalogToSave = { models: result.models }
        }
        const fetched = catalogToSave.models
        await persistProviders((current) => {
          if (!ownsOperation()) return null
          return current.map((item) => {
            if (item.id !== provider.id) return item
            const existing = new Map(item.models.map((entry) => [entry.id, entry]))
            const merged = fetched ? [
              ...fetched.map((entry) => ({ ...entry, ...existing.get(entry.id) })),
              ...item.models.filter((entry) => !fetched.some((remote) => remote.id === entry.id))
            ] : item.models
            return { ...item, models: merged }
          })
        })
        if (ownsOperation()) pushToast({ kind: 'info', title: `已获取 ${fetched?.length ?? 0} 个模型` })
      }
    } catch (err) {
      if (!ownsOperation()) return
      const message = errorMessage(err) || (mode === 'fetch' ? '获取模型失败，请重试' : '地址连接失败，请重试')
      setProviderErrors((current) => ({ ...current, [errorKey]: { mode, message, catalog: catalogToSave } }))
      if (mode === 'test') setProviderResults((current) => ({ ...current, [key]: { ok: false, error: message } }))
      pushToast({
        kind: 'error',
        title: catalogToSave ? '保存模型目录失败' : mode === 'fetch' ? '获取模型失败' : `${provider.name} 连接失败`,
        body: modelErrorSummary(message, catalogToSave ? '保存模型目录失败' : mode === 'fetch' ? '获取模型目录失败' : '地址连接失败')
      })
    } finally {
      if (ownsRequest(key, ticket)) {
        requests.current.delete(key)
        if (mounted.current) setProviderRequests((current) => {
          if (current[key]?.id !== ticket.id) return current
          const next = { ...current }; delete next[key]; return next
        })
      }
    }
  }

  const handleTestModel = async (provider: ModelProvider, model: ModelItem): Promise<void> => {
    const owner = captureSource(provider)
    observeModelInstances(latestProviders())
    const instance = getModelInstance(provider.id, model.id)
    const generation = instance.generation
    if (!ownsSource(owner) || !instance.present || viewOwner.current.id !== owner.id) return
    const key = modelResultKey(owner, model.id)
    const ticket = beginRequest(key)
    if (!ticket) return
    const ownsModel = (): boolean => ownsRequest(key, ticket) && ownsSource(owner) &&
      ownsView(owner.id, ticket.viewGeneration) && instance.present && instance.generation === generation
    instance.testKeys.add(key)
    setModelRequests((current) => ({ ...current, [key]: ticket }))
    setTestResults((current) => { const next = { ...current }; delete next[key]; return next })
    try {
      const result = await api.aiTestModel(provider, model.id)
      if (!ownsModel()) return
      const normalized = result.ok ? result : { ...result, error: result.error || '模型测试失败，请重试' }
      setTestResults((current) => ({ ...current, [key]: normalized }))
      if (!normalized.ok) pushToast({ kind: 'error', title: `模型 ${model.name || model.id} 测试失败`, body: modelErrorSummary(normalized.error || '') })
    } catch (err) {
      if (ownsModel()) {
        setTestResults((current) => ({ ...current, [key]: { ok: false, error: errorMessage(err) || '模型测试失败，请重试' } }))
      }
    } finally {
      if (ownsRequest(key, ticket)) {
        requests.current.delete(key)
        if (mounted.current) setModelRequests((current) => {
          if (current[key]?.id !== ticket.id) return current
          const next = { ...current }; delete next[key]; return next
        })
      }
    }
  }

  const openModelEditor = (provider: ModelProvider, model?: ModelItem): void => setModelEditor({
    provider, source: captureSource(provider), isNew: !model,
    model: model ? { ...model } : { id: '', name: '', enabled: true }
  })

  return (
    <div className="models-workspace-page">
      {/* 旧版配置迁移轻提示 */}
      {legacyProviderDraft(settings?.ai) && (
        <div className="model-legacy-row">
          <span className="my-item-title">检测到旧版配置数据</span>
          <Button
            variant="neutral"
            size="sm"
            disabled={saving}
            onClick={() =>
              runAction(
                persistProviders((current) => current).then(() => {
                  pushToast({ kind: 'info', title: '已导入现有配置' })
                }),
                '导入失败'
              )
            }
          >
            导入为供应商
          </Button>
        </div>
      )}

      {!settings ? (
        <div className="model-provider-empty" role="status">
          {hasIpc ? (
            <>
              <Loader2 size={16} className="animate-spin text-my-primary" />
              <span>正在加载供应商…</span>
            </>
          ) : (
            <>
              <Server size={24} aria-hidden="true" />
              <p>连接桌面应用后可管理模型供应商。</p>
            </>
          )}
        </div>
      ) : !providers.length ? (
        <div className="model-provider-empty">
          <Server size={28} className="text-my-tertiary" />
          <p className="my-item-description">暂无配置的模型供应商，可从官方模板添加或自定义接入</p>
          <Button variant="neutral" onClick={() => setShowTemplates(true)}>
            <Plus size={14} />添加供应商
          </Button>
        </div>
      ) : (
        <div className="model-workspace">
          {/* 左侧供应商紧凑导航栏 */}
          <aside className="model-provider-sidebar" aria-label="供应商列表">
            <div className="model-provider-sidebar-header">
              <span>拖动排序</span>
            </div>

            <nav className="model-provider-list my-scrollbar">
              {providers.map((provider) => {
                const active = activeProviderId === provider.id
                const isSelected = selectedProvider?.id === provider.id
                const source = captureSource(provider)
                const providerKey = providerResultKey(source)
                const pending = providerRequests[providerKey]
                const request = isSelected && pending?.viewGeneration === viewOwner.current.generation ? pending.mode : undefined
                const result = providerResults[providerKey]
                const status = getProviderStatus(provider, request === 'test', result)
                const visual = getProviderVisual(provider.name, provider.apiFormat === 'ollama')
                const enabledCount = provider.models.filter((m) => m.enabled).length

                return (
                  <button
                    type="button"
                    className="model-provider-select"
                    key={provider.id}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => selectProvider(provider.id)}
                    title={`${provider.name} (${status.label})`}
                  >
                    <span className={clsx('model-provider-avatar', visual.iconBg)}>
                      {visual.icon}
                    </span>
                    <span className="model-provider-meta">
                      <span className="model-provider-name-row">
                        <span className="my-item-title truncate font-medium">{provider.name || '未命名供应商'}</span>
                      </span>
                      <span className="model-provider-count-text">
                        {provider.models.length} 个模型
                      </span>
                    </span>
                    <span
                      className={clsx('model-provider-status-dot', status.dotClass)}
                      title={status.tooltip}
                      aria-hidden="true"
                    />
                  </button>
                )
              })}
            </nav>

            <div className="model-provider-sidebar-footer">
              <Button
                variant="neutral"
                size="sm"
                className="w-full justify-center"
                onClick={() => setShowTemplates(true)}
              >
                <Plus size={13} />添加供应商
              </Button>
            </div>
          </aside>

          {/* 右侧选中的供应商详情与模型列表 */}
          {selectedProvider && (() => {
            const provider = selectedProvider
            const active = activeProviderId === provider.id
            const source = captureSource(provider)
            const providerKey = providerResultKey(source)
            const pending = providerRequests[providerKey]
            const request = pending?.viewGeneration === viewOwner.current.generation ? pending.mode : undefined
            const result = providerResults[providerKey]
            const status = getProviderStatus(provider, request === 'test', result)
            const visual = getProviderVisual(provider.name, provider.apiFormat === 'ollama')
            const enabledModelsCount = provider.models.filter((m) => m.enabled).length

            return (
              <section
                key={provider.id}
                className="model-provider-detail my-scrollbar"
                tabIndex={0}
                aria-label={`${provider.name} 的模型`}
              >
                {/* 顶部 Header 卡片（从容舒展的独立信息卡，上下分层） */}
                <header className="model-provider-header-card">
                  <div className="model-provider-header-left">
                    <span className={clsx('model-provider-header-avatar', visual.iconBg)}>
                      {visual.icon}
                    </span>
                    <div className="model-provider-header-info">
                      <div className="model-provider-header-title">
                        <span>{provider.name || '未命名供应商'}</span>
                        {active && (
                          <span className="model-badge-quiet" title="当前用于 AI 任务调用的主供应商">
                            主用
                          </span>
                        )}
                      </div>
                      <div className="model-provider-header-endpoint" title={endpointLabel(provider.baseUrl)}>
                        <span>{endpointLabel(provider.baseUrl)}</span>
                        <span className="model-endpoint-sep">·</span>
                        <span>{provider.apiFormat === 'ollama' ? 'Ollama 协议' : 'OpenAI 协议'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="model-provider-header-actions">
                    <div className="model-header-status" title={status.tooltip}>
                      <span className={clsx('model-status-dot-sm', status.dotClass)} />
                      <span>{request === 'fetch' ? '获取中…' : status.label}</span>
                    </div>

                    {!active && (
                      <Button
                        variant="neutral"
                        size="sm"
                        disabled={saving || !provider.enabled || !provider.baseUrl.trim()}
                        onClick={() => runAction(persistProviders((current) => current, provider.id))}
                      >
                        设为主用
                      </Button>
                    )}

                    <Tooltip label="仅检查地址是否响应，不验证凭据或模型目录" wrap>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving || Boolean(request) || !provider.baseUrl.trim()}
                        onClick={() => void handleProviderRequest(provider, 'test')}
                      >
                        {request === 'test' ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                        测试连接
                      </Button>
                    </Tooltip>

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => setProviderEditor({ provider: { ...provider }, source: captureSource(provider) })}
                      title="编辑供应商配置"
                    >
                      <Pencil size={13} />
                      编辑
                    </Button>

                    <Dropdown
                      align="right"
                      width={160}
                      trigger={({ toggle }) => (
                        <Button variant="ghost" size="sm" onClick={toggle} disabled={saving} aria-label="更多操作" title="更多操作">
                          <MoreHorizontal size={15} />
                        </Button>
                      )}
                    >
                      {(close) => (
                        <>
                          <DropdownItem
                            selected={active}
                            disabled={active || !provider.enabled || !provider.baseUrl.trim()}
                            onClick={() => {
                              close()
                              runAction(persistProviders((current) => current, provider.id))
                            }}
                          >
                            设为主用
                          </DropdownItem>
                          <DropdownItem
                            icon={<Power size={14} />}
                            onClick={() => {
                              close()
                              runAction(patchProvider(provider.id, { enabled: !provider.enabled }))
                            }}
                          >
                            {provider.enabled ? '停用供应商' : '启用供应商'}
                          </DropdownItem>
                          <DropdownItem
                            icon={<Trash2 size={14} />}
                            danger
                            onClick={() => {
                              close()
                              runAction(handleDeleteProvider(provider), '删除失败')
                            }}
                          >
                            删除供应商
                          </DropdownItem>
                        </>
                      )}
                    </Dropdown>
                  </div>
                </header>

                {/* 错误提示横幅 */}
                {(['test', 'fetch'] as const).map((mode) => {
                  const failure = providerErrors[providerErrorKey(providerKey, mode)]
                  if (!failure) return null
                  const summary = failure.catalog ? '保存模型目录失败' : mode === 'fetch' ? '获取模型目录失败' : '地址连接失败'
                  return (
                    <div className="model-provider-error" key={mode}>
                      <CopyableError message={failure.message} summary={modelErrorSummary(failure.message, summary)} />
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(request) || saving}
                        onClick={() => void handleProviderRequest(provider, failure.mode, failure.catalog)}
                      >
                        重试
                      </Button>
                    </div>
                  )
                })}

                {/* 模型管理核心区 */}
                <div className="model-management-section">
                  {/* 吸顶工具条：标题、统计、刷新/添加按钮、全宽搜索框 */}
                  <div className="model-toolbar-container">
                    <div className="model-toolbar-row">
                      <div className="model-toolbar-heading">
                        <div className="model-toolbar-title-line">
                          <span className="model-toolbar-title">模型</span>
                          <span className="model-toolbar-counter">已选 {enabledModelsCount} 个</span>
                        </div>
                        <span className="model-toolbar-subtitle">用开关选择常用的对话模型。</span>
                      </div>

                      <div className="model-toolbar-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={saving || Boolean(request) || !provider.baseUrl.trim()}
                          onClick={() => void handleProviderRequest(provider, 'fetch')}
                        >
                          {request === 'fetch' ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
                          {request === 'fetch' ? '获取中…' : '获取模型'}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={saving} onClick={() => openModelEditor(provider)}>
                          <Plus size={13} />添加模型
                        </Button>
                      </div>
                    </div>

                    <div className="model-filter-bar">
                      <div className="model-category-tabs" role="tablist" aria-label="模型分类筛选">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={categoryFilter === 'all'}
                          className={clsx('model-category-tab', categoryFilter === 'all' && 'is-active')}
                          onClick={() => setCategoryFilter('all')}
                        >
                          全部
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={categoryFilter === 'enabled'}
                          className={clsx('model-category-tab', categoryFilter === 'enabled' && 'is-active')}
                          onClick={() => setCategoryFilter('enabled')}
                        >
                          已启用
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={categoryFilter === 'chat'}
                          className={clsx('model-category-tab', categoryFilter === 'chat' && 'is-active')}
                          onClick={() => setCategoryFilter('chat')}
                        >
                          对话
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={categoryFilter === 'code'}
                          className={clsx('model-category-tab', categoryFilter === 'code' && 'is-active')}
                          onClick={() => setCategoryFilter('code')}
                        >
                          代码
                        </button>
                      </div>

                      <div className="model-search-box">
                        <Search size={14} aria-hidden="true" />
                        <input
                          type="search"
                          className="model-search-input"
                          ref={modelSearchRef}
                          placeholder="搜索模型名称或 ID..."
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                        />
                        {modelSearch && (
                          <button
                            type="button"
                            className="model-search-clear"
                            aria-label="清除搜索"
                            onClick={() => setModelSearch('')}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 模型列表分组手风琴（对标 Cherry Studio 质感） */}
                  {groupedModels.length ? (
                    <div className="model-group-accordion">
                      {groupedModels.map((group) => {
                        const isCollapsed = Boolean(collapsedGroups[group.name]) && !modelSearch
                        const groupEnabledCount = group.models.filter((m) => m.enabled).length

                        return (
                          <section key={group.name} className="model-group-section" aria-label={group.name}>
                            <div
                              className="model-group-header"
                              onClick={() => toggleGroup(group.name)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  toggleGroup(group.name)
                                }
                              }}
                            >
                              <div className="model-group-header-left">
                                <ChevronDown size={13} className={clsx('model-group-chevron', isCollapsed && 'is-collapsed')} />
                                <span className="model-group-name">{group.name} {group.models.length}</span>
                              </div>
                              <span className="model-group-meta">
                                {groupEnabledCount} 已启用
                              </span>
                            </div>

                            {!isCollapsed && (
                              <div className="model-card-list">
                                {group.models.map((model) => {
                                  const brandMeta = getModelBrand(model.id, model.name)
                                  const key = modelResultKey(source, model.id)
                                  const result = testResults[key]
                                  const testing = modelRequests[key]?.viewGeneration === viewOwner.current.generation
                                  const isConfiguredChat =
                                    settings?.ai?.model === model.id &&
                                    (active || Boolean(legacyProviderDraft(settings?.ai)))
                                  const hasError = result && !result.ok && result.error
                                  const showErrorDrawer = openErrorModelId === model.id && hasError
                                  const timing = result?.ok && typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs) &&
                                    (result.latencyKind === 'first_output' || result.latencyKind === 'response')
                                    ? `${result.latencyKind === 'first_output' ? '首字' : '响应'} ${result.latencyMs}ms`
                                    : null

                                  const secondaryText = [
                                    model.contextWindow ? String(model.contextWindow) : '',
                                    ...(model.tags || [])
                                  ].filter(Boolean).join(' · ')

                                  return (
                                    <div key={model.id} className="flex flex-col gap-1" data-model-id={model.id}>
                                      <div
                                        className="model-row-item"
                                        data-active-model={isConfiguredChat ? 'true' : undefined}
                                      >
                                        <button
                                          type="button"
                                          className="model-row-left"
                                          data-model-id={model.id}
                                          aria-label={`编辑模型 ${model.name || model.id}`}
                                          onClick={() => openModelEditor(provider, model)}
                                        >
                                          <span className="model-brand-icon-wrap" title={brandMeta.brand} aria-hidden="true">
                                            {brandMeta.icon}
                                          </span>
                                          <span className="model-row-info">
                                            <span className="model-row-title-row">
                                              <span className="model-row-name my-item-title" title={model.name || model.id}>
                                                {model.name || model.id}
                                              </span>
                                              {secondaryText && (
                                                <span className="model-row-tags my-item-description">
                                                  {secondaryText}
                                                </span>
                                              )}
                                              {isConfiguredChat && (
                                                <span className="model-chip-active" title="当前用于 AI 对话的主模型">
                                                  当前对话
                                                </span>
                                              )}
                                            </span>
                                          </span>
                                        </button>

                                        <div className="model-row-right">
                                          <div className="model-row-result">
                                            {testing ? (
                                              <span role="status" className="model-test-pill bg-my-layer-2 text-my-secondary">
                                                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                                                测试中…
                                              </span>
                                            ) : result?.ok ? (
                                              <span role="status" className="model-test-pill bg-my-success-subtle text-my-success-text" title={timing || '测试通过'}>
                                                {typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs) ? (
                                                  <SignalMeter
                                                    level={result.latencyMs <= 1200 ? 3 : result.latencyMs <= 3500 ? 2 : 1}
                                                    tone={result.latencyMs <= 1200 ? 'success' : 'warning'}
                                                  />
                                                ) : (
                                                  <CheckCircle2 size={11} aria-hidden="true" />
                                                )}
                                                {timing || '测试通过'}
                                              </span>
                                            ) : result ? (
                                              <button
                                                type="button"
                                                className="model-test-pill bg-my-danger-subtle text-my-danger-text"
                                                aria-expanded={Boolean(showErrorDrawer)}
                                                aria-label={`查看模型 ${model.name || model.id} 测试错误`}
                                                onClick={() => setOpenErrorModelId(showErrorDrawer ? null : model.id)}
                                              >
                                                <XCircle size={11} aria-hidden="true" />
                                                测试失败
                                              </button>
                                            ) : null}
                                          </div>
                                          <div className="model-row-actions">
                                            <button
                                              type="button"
                                              className="my-icon-control"
                                              disabled={testing || saving || !provider.baseUrl.trim()}
                                              onClick={() => void handleTestModel(provider, model)}
                                              title="测试文本生成"
                                              aria-label={`测试模型 ${model.name || model.id} 的文本生成`}
                                            >
                                              <Zap size={15} aria-hidden="true" />
                                            </button>
                                            <button
                                              type="button"
                                              className="my-icon-control"
                                              disabled={saving}
                                              onClick={() => openModelEditor(provider, model)}
                                              title="编辑模型参数"
                                              aria-label={`编辑模型参数 ${model.name || model.id}`}
                                            >
                                              <Pencil size={15} aria-hidden="true" />
                                            </button>
                                            <button
                                              type="button"
                                              className="my-icon-control model-row-delete"
                                              disabled={saving}
                                              onClick={(e) => deleteModelWithFocus(source, model.id, e.currentTarget)}
                                              title="删除此模型"
                                              aria-label={`删除模型 ${model.name || model.id}`}
                                            >
                                              <Trash2 size={15} aria-hidden="true" />
                                            </button>
                                          </div>

                                          <button
                                            type="button"
                                            role="switch"
                                            aria-checked={model.enabled}
                                            aria-label={(model.name || model.id) + ' 启用开关'}
                                            disabled={saving}
                                            onClick={() => {
                                              runAction(
                                                patchModels(source, (models) =>
                                                  models.map((item) =>
                                                    item.id === model.id ? { ...item, enabled: !model.enabled } : item
                                                  )
                                                )
                                              )
                                            }}
                                            className="my-icon-control model-row-switch"
                                          >
                                            <span className="model-row-switch-track" aria-hidden="true"><span /></span>
                                          </button>
                                        </div>
                                      </div>

                                      {showErrorDrawer && result && result.error && (
                                        <div className="px-3 py-2 bg-my-layer-2 rounded-md border border-my-border-subtle">
                                          <CopyableError message={result.error} summary={modelErrorSummary(result.error)} />
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </section>
                        )
                      })}
                    </div>
                  ) : provider.models.length ? (
                    <div className="model-list-empty">
                      <span>没有匹配的模型</span>
                      <Button variant="ghost" size="sm" onClick={() => setModelSearch('')}>
                        清除搜索
                      </Button>
                    </div>
                  ) : (
                    <div className="model-list-empty">
                      <Server size={22} className="text-my-tertiary" />
                      <span>暂未获取或添加模型</span>
                      <Button
                        variant="neutral"
                        size="sm"
                        disabled={saving || Boolean(request) || !provider.baseUrl.trim()}
                        onClick={() => void handleProviderRequest(provider, 'fetch')}
                      >
                        从远端获取模型
                      </Button>
                    </div>
                  )}
                </div>

                </section>
            )
          })()}
        </div>
      )}

      {/* 添加供应商官方模板弹窗 */}
      <Modal open={showTemplates} onClose={() => setShowTemplates(false)} ariaLabel="选择供应商模板">
        <div className="my-modal-content">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-my-lg font-semibold text-my-primary">添加模型供应商</h2>
            <Button variant="ghost" onClick={() => setShowTemplates(false)} aria-label="关闭">
              <X size={16} />
            </Button>
          </div>
          <div className="model-template-list">
            {OFFICIAL_TEMPLATES.map((template) => {
              const visual = getProviderVisual(template.name, template.apiFormat === 'ollama')
              return (
                <button
                  type="button"
                  className="model-template-row"
                  key={template.id}
                  onClick={() => handleSelectTemplate(template)}
                >
                  <span className={clsx('model-provider-avatar', visual.iconBg)}>
                    {visual.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="my-item-title block font-medium">{template.name}</span>
                    <span className="my-item-description block truncate">{template.description}</span>
                  </span>
                  <Plus size={14} className="text-my-tertiary" />
                </button>
              )
            })}
            <button
              type="button"
              className="model-template-row"
              onClick={() => handleSelectTemplate('custom')}
            >
              <span className="model-provider-avatar bg-my-layer-2 text-my-txt-primary">
                <Plus size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="my-item-title block font-medium">自定义供应商</span>
                <span className="my-item-description block truncate">输入任意兼容 OpenAI 或 Ollama 的服务地址与 API Key</span>
              </span>
              <Plus size={14} className="text-my-tertiary" />
            </button>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={() => setShowTemplates(false)}>取消</Button>
          </div>
        </div>
      </Modal>

      {/* 供应商编辑/新建弹窗 */}
      {providerEditor && (
        <ModelProviderEditor
          key={providerEditor.provider.id}
          provider={providerEditor.provider}
          isNew={!providerEditor.source}
          onClose={() => setProviderEditor(null)}
          onSave={handleSaveProvider}
          onTestConnection={async (baseUrl) => {
            const editor = providerEditor
            const viewGeneration = viewOwner.current.generation
            const ownsEditor = (): boolean =>
              mounted.current && viewOwner.current.generation === viewGeneration &&
              (editor.source ? ownsSource(editor.source) : !latestProviders().some((item) => item.id === editor.provider.id))
            if (!ownsEditor()) throw new Error('供应商连接配置已更改，请重新打开配置窗口')
            const result = await api.aiTestConnection(baseUrl)
            if (!ownsEditor()) throw new Error('供应商连接配置已更改，请重新打开配置窗口')
            return result
          }}
        />
      )}

      {/* 单个模型编辑/新建弹窗 */}
      {modelEditor && (
        <ModelItemEditor
          key={JSON.stringify([modelEditor.provider.id, modelEditor.model.id, modelEditor.isNew])}
          providerName={modelEditor.provider.name}
          model={modelEditor.model}
          isNew={modelEditor.isNew}
          onClose={() => setModelEditor(null)}
          onSave={async (model) => {
            await patchModels(modelEditor.source, (models) => {
              if (modelEditor.isNew) {
                if (models.some((item) => item.id === model.id)) throw new Error('该模型 ID 已存在')
                return [...models, model]
              }
              if (!models.some((item) => item.id === model.id)) throw new Error('该模型已被删除，请重新添加')
              return models.map((item) =>
                item.id === model.id
                  ? { ...item, name: model.name, contextWindow: model.contextWindow, tags: model.tags }
                  : item
              )
            })
          }}
        />
      )}
    </div>
  )
}
