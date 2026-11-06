import { useState, useMemo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  RotateCw,
  Plus,
  ChevronDown,
  Check,
  Zap,
  CheckCircle2,
  XCircle,
  Trash2,
  Pencil,
  Power,
  SlidersHorizontal,
  MoreHorizontal,
  Loader2,
  Server,
  X
} from 'lucide-react'
import { useApp } from '../store'
import { api, hasIpc } from '../api'
import { Button, Dropdown, DropdownItem, Modal, Switch } from '../my/ui'
import type { ModelItem, ModelProvider, AiApiFormat, AiConfig } from '../../../shared/types'
import { errorMessage } from '../../../shared/errors'
import { CopyableError } from '../components/CopyableError'
import { PreferenceRow, PreferenceSection } from './settings/PreferenceSection'
import { ModelItemEditor, ModelProviderEditor, ProviderIdentity } from './settings/ModelEditors'
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

function getProviderStatus(p: ModelProvider, isTesting: boolean) {
  if (!p.enabled) {
    return {
      dotClass: 'bg-my-layer-3',
      label: '已停用',
      tooltip: '该供应商已停用'
    }
  }
  if (isTesting) {
    return {
      dotClass: 'bg-my-info animate-pulse',
      label: '测试中…',
      tooltip: '正在测试接口连通性…'
    }
  }
  if (!p.apiKey?.trim() && !p.apiKeyEncrypted && p.apiFormat !== 'ollama' && p.status !== 'connected' && p.status !== 'error') {
    return {
      dotClass: 'border border-my-line-strong bg-transparent',
      label: '未配置密钥',
      tooltip: '尚未填写 API 密钥'
    }
  }
  if (p.status === 'connected') {
    return {
      dotClass: 'bg-my-success',
      label: p.latencyMs ? `目录可用 ${p.latencyMs}ms` : '目录可用',
      tooltip: `模型目录接口可用${p.latencyMs ? `，耗时 ${p.latencyMs}ms` : ''}；模型推理需单独测试`
    }
  }
  if (p.status === 'error') {
    return {
      dotClass: 'bg-my-danger',
      label: '连接异常',
      tooltip: '无法连接到供应商服务器，请检查接口地址与密钥'
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
  if (ai?.providers?.length) return reconcileProviders(ai.providers)
  const legacy = legacyProviderDraft(ai)
  if (legacy) return [legacy]
  return ai?.providers ? [] : [DEFAULT_INITIAL_PROVIDER]
}

// Used only in memory to retain request ownership; never rendered or logged.
function connectionSource(provider: ModelProvider): string {
  return JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey, Boolean(provider.apiKeyEncrypted)])
}

type ProviderSource = { id: string; source: string; generation: number }
type TestResult = { ok: boolean; latencyMs?: number; error?: string }
type ModelInstance = { generation: number; present: boolean; testKeys: Set<string> }

function endpointLabel(value: string): string {
  if (!value.trim()) return '未配置接口地址'
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch { return '自定义接口地址' }
}

function ModelRelationship({ provider, selectedModelId, onSelectProvider, layoutKey, children }: {
  provider: ModelProvider
  selectedModelId: string | null
  onSelectProvider: () => void
  layoutKey: string
  children: ReactNode
}): JSX.Element {
  const graphRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const measureRef = useRef<(() => void) | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [inputMode, setInputMode] = useState<'pointer' | 'keyboard'>('pointer')
  const activeId = inputMode === 'keyboard' ? focused ?? selectedModelId : hovered ?? focused ?? selectedModelId
  const kind = activeId && activeId === selectedModelId ? 'selected' : 'preview'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) setInputMode('keyboard')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useLayoutEffect(() => {
    const graph = graphRef.current
    const path = pathRef.current
    if (!graph || !path) return
    const source = graph.querySelector<HTMLElement>('.model-graph-source')
    const scrollRoot = graph.closest<HTMLElement>('.model-provider-detail')
    const toolbar = graph.parentElement?.querySelector<HTMLElement>('.model-list-sticky')
    const node = [...graph.querySelectorAll<HTMLElement>('.model-graph-node')].find((item) => item.dataset.modelId === activeId)
    if (!source || !scrollRoot) return
    const measure = (): void => {
      if (!node || !node.isConnected) { path.setAttribute('visibility', 'hidden'); return }
      const bounds = graph.getBoundingClientRect()
      const start = source.getBoundingClientRect()
      const end = node.getBoundingClientRect()
      const viewport = scrollRoot.getBoundingClientRect()
      const top = Math.max(0, viewport.top + scrollRoot.clientTop, toolbar?.getBoundingClientRect().bottom ?? 0)
      const bottom = Math.min(window.innerHeight, viewport.top + scrollRoot.clientTop + scrollRoot.clientHeight)
      const endCenter = end.top + end.height / 2
      const startCenter = start.top + start.height / 2
      if (endCenter < top || endCenter > bottom || startCenter < top || startCenter > bottom) {
        path.setAttribute('visibility', 'hidden')
        return
      }
      const x = start.right - bounds.left
      const y = startCenter - bounds.top
      const endX = end.left - bounds.left
      const endY = endCenter - bounds.top
      const middle = x + (endX - x) / 2
      path.setAttribute('d', `M ${x} ${y} C ${middle} ${y}, ${middle} ${endY}, ${endX} ${endY}`)
      path.setAttribute('visibility', 'visible')
    }
    measure()
    let frame = 0
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    measureRef.current = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(graph)
    observer.observe(source)
    observer.observe(scrollRoot)
    if (toolbar) observer.observe(toolbar)
    if (node) { observer.observe(node); if (node.parentElement) observer.observe(node.parentElement) }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      measureRef.current = null
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [layoutKey, activeId, kind])

  useLayoutEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const nodes = [...graph.querySelectorAll<HTMLElement>('.model-graph-node')]
    setHovered((id) => id && nodes.some((node) => node.dataset.modelId === id && node.matches(':hover')) ? id : null)
    const active = document.activeElement
    const row = active instanceof HTMLElement && graph.contains(active) ? active.closest<HTMLElement>('.model-item-row') : null
    setFocused(row?.dataset.modelId ?? null)
  }, [layoutKey])

  useLayoutEffect(() => { measureRef.current?.() })

  return <div className="model-graph" ref={graphRef} onPointerMove={() => setInputMode('pointer')} onPointerDown={() => setInputMode('pointer')} onWheelCapture={() => setInputMode('pointer')} onMouseLeave={() => setHovered(null)} onFocus={(event) => { const target = event.target as HTMLElement; if (target.matches(':focus-visible')) setInputMode('keyboard'); setFocused(target.closest<HTMLElement>('.model-item-row')?.dataset.modelId ?? null) }} onBlur={(event) => { const next = event.relatedTarget; setFocused(next instanceof HTMLElement && event.currentTarget.contains(next) ? next.closest<HTMLElement>('.model-item-row')?.dataset.modelId ?? null : null) }}>
    <svg className="model-graph-lines" aria-hidden="true">
      <path key={`${activeId}:${kind}`} ref={pathRef} pathLength={1} className="model-graph-path" data-model-id={activeId ?? undefined} data-kind={kind} visibility="hidden" />
    </svg>
    <button type="button" className="model-graph-source" aria-pressed={selectedModelId === null} onClick={onSelectProvider} title={provider.name || '未命名供应商'}>
      <ProviderIdentity name={provider.name} local={provider.apiFormat === 'ollama'} />
      <span className="my-item-title">{provider.name || '未命名供应商'}</span>
      <span className="my-item-description">供应商</span>
    </button>
    <div className="model-graph-nodes" onMouseOver={(event) => setHovered((event.target as Element).closest<HTMLElement>('.model-graph-node')?.dataset.modelId ?? null)} onMouseOut={(event) => { const next = event.relatedTarget; setHovered(next instanceof Element && event.currentTarget.contains(next) ? next.closest<HTMLElement>('.model-graph-node')?.dataset.modelId ?? null : null) }}>{children}</div>
  </div>
}

export function ModelsPage(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const pushToast = useApp((state) => state.pushToast)
  const providers = useMemo(() => readProviders(settings?.ai), [settings?.ai])
  const activeProviderId = settings?.ai?.activeProviderId || (settings?.ai?.providers?.find((provider) => provider.enabled)?.id ?? legacyProviderDraft(settings?.ai)?.id ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [selectedModel, setSelectedModel] = useState<{ providerId: string; modelId: string } | null>(null)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelToolbarRef = useRef<HTMLDivElement>(null)
  const selectedProvider = providers.find((provider) => provider.id === selectedId)
    ?? providers.find((provider) => provider.id === activeProviderId)
    ?? providers[0]
  const modelViewRef = useRef({ providerId: selectedProvider?.id, search: modelSearch })
  modelViewRef.current = { providerId: selectedProvider?.id, search: modelSearch }
  const filteredModels = useMemo(() => {
    const terms = modelSearch.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return (selectedProvider?.models ?? []).filter((model) => {
      const text = [model.name, model.id, model.contextWindow, ...(model.tags || [])].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase()
      return terms.every((term) => text.includes(term))
    })
  }, [selectedProvider, modelSearch])
  const [showTemplates, setShowTemplates] = useState(false)
  const [providerEditor, setProviderEditor] = useState<{ provider: ModelProvider; source: ProviderSource | null } | null>(null)
  const [modelEditor, setModelEditor] = useState<{ provider: ModelProvider; source: ProviderSource; model: ModelItem; isNew: boolean } | null>(null)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [providerRequests, setProviderRequests] = useState<Record<string, 'test' | 'fetch'>>({})
  const [modelRequests, setModelRequests] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [providerResults, setProviderResults] = useState<Record<string, TestResult>>({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({})
  const [temperature, setTemperature] = useState(settings?.ai?.temperature ?? 0.3)
  const [savingTemperature, setSavingTemperature] = useState(false)
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const mounted = useRef(true)
  const sources = useRef(new Map<string, { source: string; generation: number }>())
  const modelInstances = useRef(new Map<string, ModelInstance>())
  const requests = useRef(new Set<string>())
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
  useEffect(() => { setTemperature(settings?.ai?.temperature ?? 0.3) }, [settings?.ai?.temperature])
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
  // Observe every committed inventory, even removal/re-addition batched into one render.
  useEffect(() => {
    observeModelInstances(latestProviders())
    return useApp.subscribe((state, previous) => {
      if (state.settings?.ai !== previous.settings?.ai) observeModelInstances(readProviders(state.settings?.ai))
    })
  }, [])
  const captureSource = (provider: ModelProvider): ProviderSource => {
    const source = connectionSource(provider)
    const previous = sources.current.get(provider.id)
    const generation = previous ? previous.generation + (previous.source === source ? 0 : 1) : 0
    sources.current.set(provider.id, { source, generation })
    return { id: provider.id, source, generation }
  }
  // Observe committed changes, including a switch away and back to identical credentials.
  const sourceRevision = providers.map((provider) => connectionSource(provider)).join('\n')
  useEffect(() => {
    for (const provider of providers) captureSource(provider)
    for (const [id, value] of sources.current) {
      if (!providers.some((provider) => provider.id === id) && value.source) {
        sources.current.set(id, { source: '', generation: value.generation + 1 })
      }
    }
  }, [sourceRevision])

  const ownsSource = (owner: ProviderSource): boolean => {
    if (!mounted.current) return false
    const provider = latestProviders().find((item) => item.id === owner.id)
    if (!provider) return false
    const current = captureSource(provider)
    return current.generation === owner.generation
  }
  const modelResultKey = (owner: ProviderSource, modelId: string): string => JSON.stringify(['model', owner.id, owner.generation, modelId, getModelInstance(owner.id, modelId).generation])
  const providerResultKey = (owner: ProviderSource): string => JSON.stringify(['provider', owner.id, owner.generation])

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
      // IPC may encrypt an unchanged plaintext key on its first write. This is
      // the same connection, so retain request/draft ownership and test feedback.
      if (submitted && previous?.source === connectionSource(submitted) &&
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
        const node = [...document.querySelectorAll<HTMLElement>('.model-provider-detail .model-graph-node')].find((item) => item.dataset.modelId === id)
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
    await persistProviders((current) => current.filter((item) => item.id !== provider.id))
    if (selectedId === provider.id) { setSelectedId(null); setModelSearch('') }
    pushToast({ kind: 'info', title: '已删除供应商', body: provider.name })
  }

  const handleProviderRequest = async (provider: ModelProvider, mode: 'fetch' | 'test'): Promise<void> => {
    const owner = captureSource(provider)
    const key = providerResultKey(owner)
    if (!provider.baseUrl.trim() || requests.current.has(key)) return
    requests.current.add(key)
    setProviderRequests((current) => ({ ...current, [key]: mode }))
    setProviderErrors((current) => { const next = { ...current }; delete next[key]; return next })
    const start = performance.now()
    let connected = false
    try {
      const result = await api.aiFetchModels(provider)
      if (!ownsSource(owner)) return
      const latencyMs = Math.round(performance.now() - start)
      if (!result.ok) throw new Error(result.error || '接口未响应或凭证无效')
      connected = true
      setProviderResults((current) => ({ ...current, [key]: { ok: true, latencyMs } }))
      const fetched = result.models
      if (mode === 'fetch') {
        await persistProviders((current) => {
          if (!ownsSource(owner)) return null
          return current.map((item) => {
            if (item.id !== provider.id) return item
            const existing = new Map(item.models.map((entry) => [entry.id, entry]))
            const merged = fetched ? [
              ...fetched.map((entry) => ({ ...entry, ...existing.get(entry.id) })),
              ...item.models.filter((entry) => !fetched.some((remote) => remote.id === entry.id))
            ] : item.models
            return { ...item, status: 'connected', latencyMs, lastTestedAt: new Date().toISOString(), models: merged }
          })
        })
      }
      if (ownsSource(owner)) pushToast({ kind: 'info', title: mode === 'fetch' ? `已获取 ${fetched?.length ?? 0} 个模型` : `${provider.name} 模型目录可用` })
    } catch (err) {
      if (!ownsSource(owner)) return
      if (connected) { reportFailure('连接结果保存失败', err); return }
      const message = errorMessage(err) || '无法连接，请重试'
      setProviderErrors((current) => ({ ...current, [key]: message }))
      setProviderResults((current) => ({ ...current, [key]: { ok: false, error: message } }))
      if (ownsSource(owner)) pushToast({ kind: 'error', title: mode === 'fetch' ? '获取模型失败' : `${provider.name} 连接失败`, body: modelErrorSummary(message, '模型目录连接失败') })
    } finally {
      requests.current.delete(key)
      if (mounted.current) setProviderRequests((current) => { const next = { ...current }; delete next[key]; return next })
    }
  }

  const handleTestModel = async (provider: ModelProvider, model: ModelItem): Promise<void> => {
    const owner = captureSource(provider)
    observeModelInstances(latestProviders())
    const instance = getModelInstance(provider.id, model.id)
    const generation = instance.generation
    const ownsModel = (): boolean => ownsSource(owner) && instance.present && instance.generation === generation
    if (!ownsModel()) return
    const key = modelResultKey(owner, model.id)
    if (requests.current.has(key)) return
    requests.current.add(key)
    instance.testKeys.add(key)
    setModelRequests((current) => ({ ...current, [key]: true }))
    setTestResults((current) => { const next = { ...current }; delete next[key]; return next })
    try {
      const result = await api.aiTestModel(provider, model.id)
      if (!ownsModel()) return
      setTestResults((current) => ({ ...current, [key]: result }))
      if (!result.ok) pushToast({ kind: 'error', title: `模型 ${model.name || model.id} 测试失败`, body: modelErrorSummary(result.error || '') })
    } catch (err) {
      if (ownsModel()) {
        setTestResults((current) => ({ ...current, [key]: { ok: false, error: errorMessage(err) || '模型测试失败，请重试' } }))
      }
    } finally {
      requests.current.delete(key)
      if (mounted.current) setModelRequests((current) => { const next = { ...current }; delete next[key]; return next })
    }
  }

  const handleSaveTemperature = async (): Promise<void> => {
    if (savingTemperature || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) return
    setSavingTemperature(true)
    try {
      await write(async () => {
        const ai = useApp.getState().settings?.ai
        if (!ai) throw new Error('设置尚未加载')
        await saveSettings({ ai: { ...ai, temperature } })
      })
      pushToast({ kind: 'info', title: '已保存生成参数' })
    } catch (err) { reportFailure('生成参数保存失败', err) } finally { setSavingTemperature(false) }
  }

  const openModelEditor = (provider: ModelProvider, model?: ModelItem): void => setModelEditor({
    provider, source: captureSource(provider), isNew: !model,
    model: model ? { ...model } : { id: '', name: '', contextWindow: '128k', tags: ['代码'], enabled: true }
  })

  return <div className="preferences-page models-page">
    <PreferenceSection id="models-providers" title="供应商" action={<div className="flex items-center gap-2">
      <Button variant="ghost" disabled={saving || !settings} onClick={() => runAction(persistProviders((current) => current), '同步配置失败')} aria-label="同步配置" title="同步配置"><RotateCw size={15} className={saving ? 'animate-spin' : ''} /></Button>
      <Button variant="primary" disabled={saving || !settings} onClick={() => setShowTemplates(true)}><Plus size={14} />添加供应商</Button>
    </div>}>
      {legacyProviderDraft(settings?.ai) && <div className="model-legacy-row"><span className="my-item-title">现有配置</span><Button variant="neutral" disabled={saving} onClick={() => runAction(persistProviders((current) => current).then(() => { pushToast({ kind: 'info', title: '已导入现有配置' }) }), '导入失败')}>导入供应商</Button></div>}
      {!settings ? <div className="model-provider-empty" role="status">{hasIpc ? <><Loader2 size={16} className="animate-spin" />正在加载供应商…</> : <><Server size={24} aria-hidden="true" /><p>连接桌面应用后可管理模型供应商。</p></>}</div> : !providers.length ? <div className="model-provider-empty"><Server size={24} className="text-my-tertiary" /><p className="my-item-description">暂无供应商</p><Button variant="neutral" onClick={() => setShowTemplates(true)}><Plus size={14} />添加供应商</Button></div> : <div className="model-workspace">
        <nav className="model-provider-list my-scrollbar" aria-label="选择供应商">
          {providers.map((provider) => {
            const active = activeProviderId === provider.id
            const source = captureSource(provider)
            const providerKey = providerResultKey(source)
            const request = providerRequests[providerKey]
            const result = providerResults[providerKey]
            const status = getProviderStatus(result ? { ...provider, status: result.ok ? 'connected' : 'error', latencyMs: result.latencyMs } : provider, request === 'test')
            return <button type="button" className="model-provider-select" key={provider.id} title={provider.name || '未命名供应商'} aria-current={selectedProvider?.id === provider.id ? 'true' : undefined} onClick={() => { setSelectedId(provider.id); setModelSearch('') }}>
              <ProviderIdentity name={provider.name} local={provider.apiFormat === 'ollama'} />
              <span className="model-provider-copy"><span className="model-provider-name"><span className="my-item-title truncate">{provider.name || '未命名供应商'}</span>{active && <span className="model-active-badge"><Check size={11} />当前</span>}</span><span className="model-provider-status" title={status.tooltip}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`} aria-hidden="true" />{request === 'fetch' ? '获取中…' : status.label}</span></span>
            </button>
          })}
        </nav>
        {selectedProvider && (() => {
          const provider = selectedProvider
          const active = activeProviderId === provider.id
          const source = captureSource(provider)
          const providerKey = providerResultKey(source)
          const request = providerRequests[providerKey]
          const selectedModelId = selectedModel?.providerId === provider.id && provider.models.some((model) => model.id === selectedModel.modelId) ? selectedModel.modelId : null
          const visibleSelectedModelId = selectedModelId && filteredModels.some((model) => model.id === selectedModelId) ? selectedModelId : null
          return <section key={provider.id} className="model-provider-detail my-scrollbar" tabIndex={0} aria-label={`${provider.name || '未命名供应商'}的模型`}>
            <div className="model-provider-detail-header">
              <div className="model-provider-detail-identity"><ProviderIdentity name={provider.name} local={provider.apiFormat === 'ollama'} /><span className="model-provider-copy"><span className="model-provider-name"><span className="my-item-title truncate" title={provider.name || '未命名供应商'}>{provider.name || '未命名供应商'}</span>{active && <span className="model-active-badge"><Check size={11} />当前</span>}</span><span className="model-provider-endpoint" title={endpointLabel(provider.baseUrl)}>{endpointLabel(provider.baseUrl)}</span></span></div>
              <div className="model-provider-actions">
                {!active && <Button variant="neutral" size="sm" aria-label={`使用供应商 ${provider.name}`} disabled={saving || !provider.enabled || !provider.baseUrl.trim()} onClick={() => runAction(persistProviders((current) => current, provider.id))}>使用</Button>}
                <Button variant="ghost" size="sm" disabled={saving || Boolean(request) || !provider.baseUrl.trim()} onClick={() => void handleProviderRequest(provider, 'test')} aria-label={`测试供应商 ${provider.name}`} title={provider.status === 'error' ? '重试连接' : '测试连接'}>{request === 'test' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}</Button>
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => setProviderEditor({ provider: { ...provider }, source: captureSource(provider) })} aria-label={`编辑供应商 ${provider.name}`} title="编辑供应商"><Pencil size={14} /></Button>
                <Dropdown align="right" width={160} trigger={({ toggle }) => <Button variant="ghost" size="sm" onClick={toggle} disabled={saving} aria-label={`${provider.name} 更多操作`} title="更多操作"><MoreHorizontal size={16} /></Button>}>
                  {(close) => <>
                    <DropdownItem selected={active} disabled={active || !provider.enabled || !provider.baseUrl.trim()} icon={<Check size={14} />} onClick={() => { close(); runAction(persistProviders((current) => current, provider.id)) }}>设为当前</DropdownItem>
                    <DropdownItem icon={<Power size={14} />} onClick={() => { close(); runAction(patchProvider(provider.id, { enabled: !provider.enabled })) }}>{provider.enabled ? '停用供应商' : '启用供应商'}</DropdownItem>
                    <DropdownItem icon={<Trash2 size={14} />} danger onClick={() => { close(); runAction(handleDeleteProvider(provider), '删除失败') }}>删除供应商</DropdownItem>
                  </>}
                </Dropdown>
              </div>
            </div>
            {providerErrors[providerKey] && <div className="model-provider-error"><CopyableError message={providerErrors[providerKey]} summary={modelErrorSummary(providerErrors[providerKey], '模型目录连接失败')} /><Button variant="ghost" size="sm" disabled={Boolean(request) || saving} onClick={() => void handleProviderRequest(provider, 'test')}>重试</Button></div>}
            <div className="model-provider-models">
              <div className="model-list-sticky" ref={modelToolbarRef}>
              <div className="model-list-toolbar"><span className="my-item-title">模型 <span className="my-item-description ml-1">{provider.models.filter((model) => model.enabled).length} / {provider.models.length} 已启用</span></span><div className="flex flex-wrap items-center gap-1"><Button variant="ghost" size="sm" disabled={saving || Boolean(request) || !provider.baseUrl.trim()} onClick={() => void handleProviderRequest(provider, 'fetch')}>{request === 'fetch' ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}{request === 'fetch' ? '获取中…' : '获取模型'}</Button><Button variant="ghost" size="sm" disabled={saving} onClick={() => openModelEditor(provider)}><Plus size={13} />添加模型</Button></div></div>
              <input ref={modelSearchRef} className="my-input model-search" type="search" aria-label={`搜索 ${provider.name || '供应商'}的模型`} placeholder="搜索模型名称或 ID" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />
              </div>
            {filteredModels.length ? <ModelRelationship provider={provider} selectedModelId={visibleSelectedModelId} onSelectProvider={() => { if (visibleSelectedModelId) setSelectedModel(null) }} layoutKey={JSON.stringify([provider.id, filteredModels.map((model) => model.id), visibleSelectedModelId])}>{filteredModels.map((model) => {
              const key = modelResultKey(source, model.id)
              const result = testResults[key]
              const testing = modelRequests[key]
              const selected = selectedModelId === model.id
              const isConfigured = settings.ai.model === model.id && (settings.ai.providers?.length ? settings.ai.activeProviderId === provider.id : Boolean(legacyProviderDraft(settings.ai)))
              return <div key={model.id} className="model-item-row" data-model-id={model.id} data-selected={selected || undefined}>
                <button type="button" className="model-graph-node" data-model-id={model.id} aria-expanded={selected} onClick={() => setSelectedModel(selected ? null : { providerId: provider.id, modelId: model.id })}>
                  <span className="model-item-icon" aria-hidden="true"><Server size={15} /></span>
                  <span className="model-item-copy"><span className="my-item-title block truncate" title={model.name || model.id}>{model.name || model.id}</span><span className="my-item-description block truncate" title={[model.id, model.contextWindow, ...(model.tags || [])].filter(Boolean).join(' · ')}>{[model.name !== model.id ? model.id : '', model.contextWindow, ...(model.tags || [])].filter(Boolean).join(' · ') || model.id}</span></span>
                  <span className="model-node-state">{isConfigured && <span>配置模型</span>}<span>{model.enabled ? '已启用' : '已停用'}</span>{testing ? <span>测试中…</span> : result && <span className={result.ok ? 'text-my-success-text' : 'text-my-danger-text'}>{result.ok ? '推理成功' : '测试失败'}</span>}</span>
                </button>
                {selected && <div className="model-item-detail">
                  {result && <span className={`model-test-result ${result.ok ? 'text-my-success-text' : 'text-my-danger-text'}`} role="status" title={result.error ? modelErrorSummary(result.error) : '模型推理请求成功'}>{result.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{result.ok ? result.latencyMs === undefined ? '推理成功' : `推理成功 ${result.latencyMs}ms` : '测试失败'}</span>}
                  <div className="model-item-actions"><Button variant="ghost" size="sm" disabled={saving || testing || !provider.baseUrl.trim()} onClick={() => void handleTestModel(provider, model)} aria-label={`测试模型 ${model.name || model.id}`} title="测试模型推理（将调用 API）">{testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}测试</Button><Button variant="ghost" size="sm" disabled={saving} onClick={() => openModelEditor(provider, model)} aria-label={`编辑模型 ${model.name || model.id}`} title="编辑模型"><Pencil size={14} /></Button><Button variant="ghost" size="sm" disabled={saving} onClick={(event) => deleteModelWithFocus(source, model.id, event.currentTarget)} aria-label={`删除模型 ${model.name || model.id}`} title="删除模型"><Trash2 size={14} /></Button><Switch checked={model.enabled} disabled={saving} onChange={(enabled) => runAction(patchModels(source, (models) => models.map((item) => item.id === model.id ? { ...item, enabled } : item)))} label={`启用模型 ${model.name || model.id}`} /></div>
                  {result?.ok === false && result.error && <div className="model-test-error"><CopyableError message={result.error} summary={modelErrorSummary(result.error)} /></div>}
                </div>}
              </div>
            })}</ModelRelationship> : provider.models.length ? <div className="model-list-empty"><span>没有匹配的模型</span><Button variant="ghost" size="sm" onClick={() => { setModelSearch(''); modelSearchRef.current?.focus() }}>清除搜索</Button></div> : <div className="model-list-empty"><Server size={20} className="text-my-tertiary" /><span>暂无模型</span><Button variant="neutral" size="sm" disabled={saving || Boolean(request) || !provider.baseUrl.trim()} onClick={() => void handleProviderRequest(provider, 'fetch')}>获取模型</Button></div>}
            </div>
          </section>
        })()}
      </div>}
    </PreferenceSection>

    <details className="model-advanced"><summary><SlidersHorizontal size={15} /><span>高级参数</span><ChevronDown size={14} /></summary><PreferenceRow label="温度" htmlFor="models-temperature"><input id="models-temperature" type="range" min={0} max={1} step={0.1} value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} disabled={savingTemperature || !settings} className="min-w-0 flex-1" /><output htmlFor="models-temperature" className="text-my-sm text-my-secondary">{temperature}</output></PreferenceRow><div className="flex justify-end pb-4"><Button variant="neutral" disabled={saving || savingTemperature || !settings || temperature === (settings.ai.temperature ?? 0.3)} onClick={() => void handleSaveTemperature()}>{savingTemperature && <Loader2 size={13} className="animate-spin" />}{savingTemperature ? '保存中…' : '保存参数'}</Button></div></details>

    <Modal open={showTemplates} onClose={() => setShowTemplates(false)} ariaLabel="选择供应商">
      <div className="my-modal-content"><div className="mb-4 flex items-center justify-between"><h2 className="text-my-lg font-semibold text-my-primary">添加供应商</h2><Button variant="ghost" onClick={() => setShowTemplates(false)} aria-label="关闭供应商模板"><X size={17} /></Button></div><div className="model-template-list">{OFFICIAL_TEMPLATES.map((template) => <button type="button" className="model-template-row" key={template.id} onClick={() => handleSelectTemplate(template)}><ProviderIdentity name={template.name} local={template.apiFormat === 'ollama'} /><span className="min-w-0 flex-1"><span className="my-item-title block">{template.name}</span><span className="my-item-description block truncate">{endpointLabel(template.baseUrl)}</span></span><Plus size={15} className="text-my-tertiary" /></button>)}<button type="button" className="model-template-row" onClick={() => handleSelectTemplate('custom')}><ProviderIdentity name="+" /><span className="my-item-title flex-1 text-left">自定义供应商</span><Plus size={15} className="text-my-tertiary" /></button></div><div className="mt-4 flex justify-end"><Button variant="ghost" onClick={() => setShowTemplates(false)}>取消</Button></div></div>
    </Modal>
    {providerEditor && <ModelProviderEditor key={providerEditor.provider.id} provider={providerEditor.provider} isNew={!providerEditor.source} onClose={() => setProviderEditor(null)} onSave={handleSaveProvider} onTest={async (draft) => {
      const editor = providerEditor
      const ownsEditor = (): boolean => editor.source ? ownsSource(editor.source) : mounted.current && !latestProviders().some((item) => item.id === draft.id)
      if (!ownsEditor()) throw new Error('供应商连接配置已更改，请重新打开配置窗口')
      const startedAt = performance.now()
      const result = await api.aiFetchModels(draft)
      if (!ownsEditor()) throw new Error('供应商连接配置已更改，请重新打开配置窗口')
      return { ok: result.ok, error: result.error, latencyMs: Math.round(performance.now() - startedAt) }
    }} />}
    {modelEditor && <ModelItemEditor key={JSON.stringify([modelEditor.provider.id, modelEditor.model.id, modelEditor.isNew])} providerName={modelEditor.provider.name} model={modelEditor.model} isNew={modelEditor.isNew} onClose={() => setModelEditor(null)} onSave={async (model) => {
      await patchModels(modelEditor.source, (models) => {
        if (modelEditor.isNew) {
          if (models.some((item) => item.id === model.id)) throw new Error('该模型 ID 已存在')
          return [...models, model]
        }
        if (!models.some((item) => item.id === model.id)) throw new Error('该模型已被删除，请重新添加')
        return models.map((item) => item.id === model.id ? { ...item, name: model.name, contextWindow: model.contextWindow, tags: model.tags } : item)
      })
    }} />}
  </div>
}
