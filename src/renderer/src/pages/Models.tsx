import { useState, useMemo, useEffect } from 'react'
import {
  RotateCw,
  Plus,
  Box,
  Boxes,
  Sparkles,
  Zap,
  Check,
  CheckCircle2,
  XCircle,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  MoreHorizontal,
  Loader2,
  ChevronDown,
  Bot,
  X
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import type { ModelItem, ModelProvider, AiApiFormat } from '../../../shared/types'
import { clsx } from 'clsx'

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
      dotClass: 'bg-ink-600',
      badgeClass: 'border-ink-700 bg-ink-800 text-mist-500',
      label: '已停用',
      tooltip: '该供应商已停用'
    }
  }
  if (isTesting) {
    return {
      dotClass: 'bg-sky-400 animate-pulse shadow-[0_0_6px_rgba(56,189,248,0.7)]',
      badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
      label: '测试中…',
      tooltip: '正在测试接口连通性…'
    }
  }
  if (!p.apiKey?.trim() && p.apiFormat !== 'ollama') {
    return {
      dotClass: 'border border-mist-500 bg-transparent',
      badgeClass: 'border-ink-700 bg-ink-800 text-mist-400',
      label: '未配置 Key',
      tooltip: '尚未填写 API Key'
    }
  }
  if (p.status === 'connected') {
    return {
      dotClass: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]',
      badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      label: p.latencyMs ? `已连通 ${p.latencyMs}ms` : '已连通',
      tooltip: `连通正常${p.latencyMs ? `，耗时 ${p.latencyMs}ms` : ''}`
    }
  }
  if (p.status === 'error') {
    return {
      dotClass: 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.7)]',
      badgeClass: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
      label: '连接异常',
      tooltip: '无法连接到供应商服务器，请检查 Base URL 与 API Key'
    }
  }
  return {
    dotClass: 'bg-amber-400/80',
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
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
  // 移除历史测试计划
  const clean = saved.filter((p) => p.id !== 'zhipu-plan' && p.name !== 'Start Plan')

  // 保留真正配置了 API Key，或者已有拉取模型的供应商
  const configured = clean.filter((p) => {
    const hasKey = Boolean(p.apiKey?.trim())
    const hasModels = Boolean(p.models && p.models.length > 0)
    return hasKey || hasModels
  })

  // 如果没有任何配置过的供应商，只给一个默认项（DeepSeek），不展示全部
  const effective = configured.length > 0 ? configured : [DEFAULT_INITIAL_PROVIDER]

  return effective.map((p) => {
    const tpl = OFFICIAL_TEMPLATES.find((t) => t.id === p.id)
    return {
      ...p,
      group: p.group || (tpl ? '官方供应商' : '自定义供应商'),
      status: p.status || 'untested',
      models:
        p.models?.filter(
          (m) =>
            !['glm-4-flash', 'glm-4-plus', 'k3', 'moonshot-v1-128k', 'deepseek-chat', 'deepseek-reasoner', 'gpt-4o', 'gpt-4o-mini', 'glm-4-air'].includes(m.id) ||
            m.lastTestedAt
        ) ?? []
    }
  })
}

export function ModelsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const pushToast = useApp((s) => s.pushToast)

  // Initialize providers from settings: 未添加模型时默认给一个初始项（DeepSeek）
  const [providers, setProviders] = useState<ModelProvider[]>(() => {
    if (settings?.ai?.providers && settings.ai.providers.length > 0) {
      return reconcileProviders(settings.ai.providers)
    }
    return [DEFAULT_INITIAL_PROVIDER]
  })

  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const active = settings?.ai?.activeProviderId
    if (active && providers.some((p) => p.id === active)) {
      return active
    }
    return providers[0]?.id || 'deepseek'
  })

  // 当供应商列表变动时，确保选中的 ID 有效
  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id)
    }
  }, [providers, selectedProviderId])

  const [showKey, setShowKey] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null)
  const [testingModelId, setTestingModelId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({})
  const [editingModel, setEditingModel] = useState<ModelItem | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showAddProviderModal, setShowAddProviderModal] = useState(false)
  const [newModelForm, setNewModelForm] = useState({ id: '', name: '', contextWindow: '128k', tags: '代码' })
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  // Currently selected provider
  const currentProvider = useMemo(() => {
    return providers.find((p) => p.id === selectedProviderId) || providers[0]
  }, [providers, selectedProviderId])

  // Sync to store when providers change
  const persistProviders = async (nextProviders: ModelProvider[], nextActiveId?: string): Promise<void> => {
    setProviders(nextProviders)
    const activeId = nextActiveId ?? selectedProviderId
    const activeP = nextProviders.find((p) => p.id === activeId)
    const activeModel = activeP?.models.find((m) => m.enabled)?.id || activeP?.models[0]?.id || ''

    await saveSettings({
      ai: {
        enabled: activeP?.enabled ?? settings?.ai?.enabled ?? true,
        baseUrl: activeP?.baseUrl || settings?.ai?.baseUrl || '',
        apiKey: activeP?.apiKey ?? settings?.ai?.apiKey ?? '',
        apiKeyEncrypted: activeP?.apiKeyEncrypted ?? settings?.ai?.apiKeyEncrypted,
        model: activeModel || settings?.ai?.model || '',
        temperature: settings?.ai?.temperature ?? 0.7,
        activeProviderId: activeId,
        apiFormat: activeP?.apiFormat ?? settings?.ai?.apiFormat ?? 'openai',
        providers: nextProviders
      }
    })
  }

  // Update current provider attributes
  const updateCurrentProvider = (patch: Partial<ModelProvider>): void => {
    if (!currentProvider) return
    const isConnParamChanged = 'baseUrl' in patch || 'apiKey' in patch || 'apiFormat' in patch
    const statusPatch = isConnParamChanged ? { status: 'untested' as const, latencyMs: undefined } : {}
    const next = providers.map((p) => (p.id === currentProvider.id ? { ...p, ...patch, ...statusPatch } : p))
    void persistProviders(next)
  }

  // Auto fetch models from provider
  const handleFetchModels = async (): Promise<void> => {
    if (!currentProvider) return
    if (!currentProvider.baseUrl) {
      pushToast({ kind: 'warn', title: '无法获取模型', body: '请先填写 Base URL' })
      return
    }

    setFetchingModels(true)
    const start = performance.now()
    try {
      const res = await api.aiFetchModels(currentProvider)
      const latency = Math.round(performance.now() - start)
      if (res.ok && res.models && res.models.length > 0) {
        const fetched = res.models
        // Merge with existing models without losing user custom enabled states
        const existingMap = new Map(currentProvider.models.map((m) => [m.id, m]))
        const mergedModels: ModelItem[] = fetched.map((m) => {
          const existing = existingMap.get(m.id)
          return {
            ...m,
            enabled: existing ? existing.enabled : true
          }
        })

        const next = providers.map((p) =>
          p.id === currentProvider.id
            ? {
                ...p,
                models: mergedModels,
                status: 'connected' as const,
                latencyMs: latency,
                lastTestedAt: new Date().toISOString()
              }
            : p
        )
        void persistProviders(next)
        pushToast({
          kind: 'info',
          title: '拉取模型成功',
          body: `已成功获取 ${fetched.length} 个模型并推断参数`
        })
      } else {
        const next = providers.map((p) =>
          p.id === currentProvider.id
            ? { ...p, status: 'error' as const, lastTestedAt: new Date().toISOString() }
            : p
        )
        void persistProviders(next)
        pushToast({
          kind: 'error',
          title: '拉取模型失败',
          body: res.error || '未获取到模型列表，请确认 Base URL 与 API Key 是否有效'
        })
      }
    } catch (err: any) {
      const next = providers.map((p) =>
        p.id === currentProvider.id
          ? { ...p, status: 'error' as const, lastTestedAt: new Date().toISOString() }
          : p
      )
      void persistProviders(next)
      pushToast({
        kind: 'error',
        title: '拉取模型异常',
        body: err?.message || String(err)
      })
    } finally {
      setFetchingModels(false)
    }
  }

  // Test single model connection & latency
  const handleTestModel = async (modelId: string): Promise<void> => {
    if (!currentProvider) return
    setTestingModelId(modelId)
    try {
      const res = await api.aiTestModel(currentProvider, modelId)
      setTestResults((prev) => ({
        ...prev,
        [modelId]: { ok: res.ok, latencyMs: res.latencyMs, error: res.error }
      }))
      if (res.ok) {
        const next = providers.map((p) =>
          p.id === currentProvider.id
            ? {
                ...p,
                status: 'connected' as const,
                latencyMs: res.latencyMs,
                lastTestedAt: new Date().toISOString()
              }
            : p
        )
        void persistProviders(next)
        pushToast({
          kind: 'info',
          title: `模型 ${modelId} 连通正常`,
          body: `响应耗时: ${res.latencyMs}ms`
        })
      } else {
        pushToast({
          kind: 'error',
          title: `模型 ${modelId} 连接失败`,
          body: res.error || '无法与模型服务器建立连接'
        })
      }
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [modelId]: { ok: false, error: err?.message || String(err) }
      }))
    } finally {
      setTestingModelId(null)
    }
  }

  // Provider-level test connection
  const handleTestProvider = async (providerToTest: ModelProvider): Promise<void> => {
    if (!providerToTest.baseUrl) {
      pushToast({ kind: 'warn', title: '无法测试', body: '请先填写 Base URL' })
      return
    }
    setTestingProviderId(providerToTest.id)
    const start = performance.now()
    try {
      const activeModel = providerToTest.models.find((m) => m.enabled) || providerToTest.models[0]
      if (activeModel) {
        const res = await api.aiTestModel(providerToTest, activeModel.id)
        const latency = res.latencyMs ?? Math.round(performance.now() - start)
        if (res.ok) {
          const next = providers.map((p) =>
            p.id === providerToTest.id
              ? { ...p, status: 'connected' as const, latencyMs: latency, lastTestedAt: new Date().toISOString() }
              : p
          )
          void persistProviders(next)
          pushToast({
            kind: 'info',
            title: `${providerToTest.name} 连接成功`,
            body: `模型 ${activeModel.name} 响应耗时: ${latency}ms`
          })
        } else {
          const next = providers.map((p) =>
            p.id === providerToTest.id
              ? { ...p, status: 'error' as const, lastTestedAt: new Date().toISOString() }
              : p
          )
          void persistProviders(next)
          pushToast({
            kind: 'error',
            title: `${providerToTest.name} 连接失败`,
            body: res.error || '无法与模型服务器建立连接'
          })
        }
      } else {
        const res = await api.aiFetchModels(providerToTest)
        const latency = Math.round(performance.now() - start)
        if (res.ok) {
          const fetchedModels = res.models || []
          const next = providers.map((p) =>
            p.id === providerToTest.id
              ? {
                  ...p,
                  status: 'connected' as const,
                  latencyMs: latency,
                  lastTestedAt: new Date().toISOString(),
                  models: p.models.length === 0 ? fetchedModels : p.models
                }
              : p
          )
          void persistProviders(next)
          pushToast({
            kind: 'info',
            title: `${providerToTest.name} 连接成功`,
            body: `接口连通正常 (耗时: ${latency}ms)${fetchedModels.length > 0 && providerToTest.models.length === 0 ? `，已自动同步 ${fetchedModels.length} 个模型` : ''}`
          })
        } else {
          const next = providers.map((p) =>
            p.id === providerToTest.id
              ? { ...p, status: 'error' as const, lastTestedAt: new Date().toISOString() }
              : p
          )
          void persistProviders(next)
          pushToast({
            kind: 'error',
            title: `${providerToTest.name} 连接失败`,
            body: res.error || '接口未响应或凭证无效'
          })
        }
      }
    } catch (err: any) {
      const next = providers.map((p) =>
        p.id === providerToTest.id
          ? { ...p, status: 'error' as const, lastTestedAt: new Date().toISOString() }
          : p
      )
      void persistProviders(next)
      pushToast({
        kind: 'error',
        title: '测试连接异常',
        body: err?.message || String(err)
      })
    } finally {
      setTestingProviderId(null)
    }
  }

  // Select template to add provider
  const handleSelectTemplate = (tpl: ProviderTemplate | 'custom'): void => {
    let newProvider: ModelProvider
    if (tpl === 'custom') {
      const newId = `custom-${Date.now().toString(36)}`
      newProvider = {
        id: newId,
        name: `自定义供应商 ${providers.length + 1}`,
        group: '自定义供应商',
        baseUrl: '',
        apiFormat: 'openai',
        apiKey: '',
        enabled: true,
        models: [],
        status: 'untested'
      }
    } else {
      const exists = providers.some((p) => p.id === tpl.id)
      const newId = exists ? `${tpl.id}-${Date.now().toString(36)}` : tpl.id
      newProvider = {
        id: newId,
        name: exists ? `${tpl.name} (${providers.filter((p) => p.id.startsWith(tpl.id)).length + 1})` : tpl.name,
        group: tpl.group,
        baseUrl: tpl.baseUrl,
        apiFormat: tpl.apiFormat,
        apiKey: '',
        enabled: true,
        models: [],
        status: 'untested'
      }
    }
    const next = [...providers, newProvider]
    setSelectedProviderId(newProvider.id)
    void persistProviders(next, newProvider.id)
    setShowAddProviderModal(false)
    pushToast({ kind: 'info', title: '已添加供应商', body: newProvider.name })
  }

  // Delete current provider
  const handleDeleteCurrentProvider = (): void => {
    const next = providers.filter((p) => p.id !== currentProvider?.id)
    const nextActive = next[0]?.id || ''
    setSelectedProviderId(nextActive)
    setMoreMenuOpen(false)
    void persistProviders(next, nextActive)
    if (currentProvider) {
      pushToast({ kind: 'info', title: '已删除供应商', body: currentProvider.name })
    }
  }

  // Add custom model manually
  const handleAddCustomModel = (): void => {
    if (!newModelForm.id.trim()) return
    const tagsArray = newModelForm.tags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    const newModel: ModelItem = {
      id: newModelForm.id.trim(),
      name: newModelForm.name.trim() || newModelForm.id.trim(),
      contextWindow: newModelForm.contextWindow.trim() || '128k',
      tags: tagsArray.length > 0 ? tagsArray : ['代码'],
      enabled: true
    }
    const nextModels = [...(currentProvider.models || []), newModel]
    updateCurrentProvider({ models: nextModels })
    setShowAddModal(false)
    setNewModelForm({ id: '', name: '', contextWindow: '128k', tags: '代码' })
  }

  // Save edited model
  const handleSaveEditedModel = (): void => {
    if (!editingModel) return
    const nextModels = currentProvider.models.map((m) => (m.id === editingModel.id ? editingModel : m))
    updateCurrentProvider({ models: nextModels })
    setEditingModel(null)
  }

  // Group providers by group name
  const groupedProviders = useMemo(() => {
    const groups: Record<string, ModelProvider[]> = {}
    for (const p of providers) {
      const g = p.group || '自定义供应商'
      if (!groups[g]) groups[g] = []
      groups[g].push(p)
    }
    const ordered: Record<string, ModelProvider[]> = {}
    if (groups['官方供应商']) ordered['官方供应商'] = groups['官方供应商']
    for (const [k, v] of Object.entries(groups)) {
      if (k !== '官方供应商') ordered[k] = v
    }
    return ordered
  }, [providers])

  return (
    <div className="flex h-full flex-col bg-ink-900 p-8 text-mist-100">
      {/* 顶部标题与操作栏 */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-mist-100">模型管理</h1>
          <p className="mt-1 text-sm text-mist-400">管理官方预设与自定义模型供应商，支持自动获取模型与连通测试。</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void persistProviders(providers)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-600 bg-ink-750/80 text-mist-200 transition-colors hover:border-ink-500 hover:bg-ink-700 hover:text-mist-50 cursor-pointer"
            title="刷新与重新同步"
          >
            <RotateCw size={15} />
          </button>
          <button
            onClick={() => setShowAddProviderModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:bg-emerald-500 active:bg-emerald-700 cursor-pointer"
          >
            <Plus size={14} />
            添加供应商
          </button>
        </div>
      </div>

      {/* 主双栏容器 */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-ink-700/80 bg-ink-850">
        {/* 左栏：供应商分组列表 */}
        <div className="flex w-64 shrink-0 flex-col border-r border-ink-700/70 p-3 bg-ink-850/50">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {providers.length > 0 ? (
              Object.entries(groupedProviders).map(([groupName, groupItems]) => (
                <div key={groupName}>
                  <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-mist-500">{groupName}</div>
                  <div className="space-y-1">
                    {groupItems.map((p) => {
                      const isSelected = p.id === currentProvider?.id
                      const statusInfo = getProviderStatus(p, testingProviderId === p.id)
                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProviderId(p.id)
                            void persistProviders(providers, p.id)
                          }}
                          className={clsx(
                            'group flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors cursor-pointer',
                            isSelected
                              ? 'bg-leaf-dim/15 font-semibold text-leaf-soft border border-leaf-dim/30 shadow-xs'
                              : 'text-mist-200 hover:bg-ink-700/60 hover:text-mist-50'
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            {p.group === '官方供应商' ? (
                              p.id === 'zhipu' || p.name.includes('BigModel') || p.name.includes('智谱') ? (
                                <Sparkles size={15} className="shrink-0 text-blue-400" />
                              ) : p.id === 'deepseek' || p.name.includes('DeepSeek') ? (
                                <Bot size={15} className="shrink-0 text-sky-400" />
                              ) : p.id === 'kimi' || p.name.includes('Kimi') ? (
                                <Sparkles size={15} className="shrink-0 text-emerald-400" />
                              ) : p.id === 'openai' || p.name.includes('OpenAI') ? (
                                <Bot size={15} className="shrink-0 text-indigo-400" />
                              ) : (
                                <Box size={15} className="shrink-0 text-mist-300" />
                              )
                            ) : (
                              <Box size={15} className="shrink-0 text-mist-400 group-hover:text-mist-300" />
                            )}
                            <span className="truncate">{p.name}</span>
                          </div>
                          <span
                            title={statusInfo.tooltip}
                            className={clsx('h-2 w-2 shrink-0 rounded-full transition-all', statusInfo.dotClass)}
                          />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-ink-700/60 p-4 text-center">
                <Boxes size={24} className="mb-2 text-mist-500 opacity-60" />
                <span className="text-xs font-medium text-mist-300">已接入列表暂空</span>
                <span className="mt-1 text-[11px] leading-relaxed text-mist-500">
                  请点击右上角「添加供应商」
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 右栏：供应商配置详情与模型列表 */}
        {currentProvider ? (
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-7">
            {/* 供应商头部 */}
            <div className="mb-6 flex items-center justify-between border-b border-ink-750 pb-5">
              <div className="flex items-center gap-3">
                <Box size={22} className="text-mist-200" />
                <input
                  type="text"
                  value={currentProvider.name}
                  onChange={(e) => updateCurrentProvider({ name: e.target.value })}
                  className="rounded px-1 bg-transparent text-lg font-bold text-mist-100 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                {(() => {
                  const statusInfo = getProviderStatus(currentProvider, testingProviderId === currentProvider.id)
                  return (
                    <span
                      className={clsx(
                        'rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide transition-colors',
                        statusInfo.badgeClass
                      )}
                      title={statusInfo.tooltip}
                    >
                      {statusInfo.label}
                    </span>
                  )
                })()}
              </div>
              <div className="relative flex items-center gap-3">
                {/* 测试连接按钮 */}
                <button
                  onClick={() => void handleTestProvider(currentProvider)}
                  disabled={testingProviderId === currentProvider.id || !currentProvider.baseUrl}
                  className="flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-750/80 px-2.5 py-1.5 text-xs font-medium text-mist-100 transition-colors hover:border-ink-500 hover:bg-ink-700 hover:text-mist-50 disabled:opacity-40 cursor-pointer"
                  title="真实测试供应商连通性与测速"
                >
                  {testingProviderId === currentProvider.id ? (
                    <Loader2 size={13} className="animate-spin text-sky-400" />
                  ) : (
                    <Zap size={13} className="text-amber-400" />
                  )}
                  <span>{testingProviderId === currentProvider.id ? '测试中…' : '测试连接'}</span>
                </button>

                {/* 供应商总开关 */}
                <label className="relative inline-flex cursor-pointer items-center" title={currentProvider.enabled ? '已启用' : '已停用'}>
                  <input
                    type="checkbox"
                    checked={currentProvider.enabled}
                    onChange={(e) => updateCurrentProvider({ enabled: e.target.checked })}
                    className="peer sr-only"
                  />
                  <div className="h-5 w-9 rounded-full bg-ink-600 transition-colors peer-checked:bg-emerald-500 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all peer-checked:after:translate-x-4 after:content-['']" />
                </label>

                {/* 更多菜单 */}
                <button
                  onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-mist-400 hover:bg-ink-750 hover:text-mist-100"
                >
                  <MoreHorizontal size={17} />
                </button>

                {moreMenuOpen && (
                  <div className="absolute right-0 top-10 z-30 w-36 rounded-lg border border-ink-700 bg-ink-800 py-1 shadow-xl">
                    <button
                      onClick={handleDeleteCurrentProvider}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-ink-700/60"
                    >
                      <Trash2 size={13} />
                      删除供应商
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 配置表单 */}
            <div className="space-y-5">
              {/* Base URL */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-mist-400">Base URL</label>
                <input
                  type="text"
                  value={currentProvider.baseUrl}
                  onChange={(e) => updateCurrentProvider({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-lg border border-ink-700 bg-ink-900/90 px-3.5 py-2.5 text-xs text-mist-100 placeholder-mist-600 transition-colors focus:border-ink-500 focus:outline-none"
                />
              </div>

              {/* API 格式 */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-mist-400">API 格式</label>
                <div className="relative">
                  <select
                    value={currentProvider.apiFormat}
                    onChange={(e) => updateCurrentProvider({ apiFormat: e.target.value as AiApiFormat })}
                    className="w-full appearance-none rounded-lg border border-ink-700 bg-ink-900/90 px-3.5 py-2.5 pr-8 text-xs text-mist-100 transition-colors focus:border-ink-500 focus:outline-none"
                  >
                    <option value="openai">OpenAI Compatible (/v1/chat/completions)</option>
                    <option value="response">OpenAI Response (/v1/responses)</option>
                    <option value="anthropic">Anthropic Messages (/v1/messages)</option>
                    <option value="ollama">Ollama (/api/tags)</option>
                  </select>
                  <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-mist-500" />
                </div>
              </div>

              {/* API Key */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <label className="font-medium text-mist-400">
                    API Key
                    {currentProvider.apiKeyEncrypted && (
                      <span className="ml-2 text-[10px] text-emerald-400 font-normal">（已加密保存）</span>
                    )}
                  </label>
                </div>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={currentProvider.apiKey}
                    onChange={(e) => updateCurrentProvider({ apiKey: e.target.value, apiKeyEncrypted: false })}
                    placeholder="输入 API Key"
                    className="w-full rounded-lg border border-ink-700 bg-ink-900/90 px-3.5 py-2.5 pr-10 text-xs text-mist-100 placeholder-mist-600 transition-colors focus:border-ink-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-2.5 text-mist-400 hover:text-mist-200"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              {/* 模型列表区域 */}
              <div className="pt-3">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-wide text-mist-300">模型列表</span>
                  <div className="flex items-center gap-2">
                    {/* 自动拉取模型按钮 (用户核心要求) */}
                    <button
                      onClick={() => void handleFetchModels()}
                      disabled={fetchingModels || !currentProvider.baseUrl}
                      className="flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-750/80 px-2.5 py-1.5 text-xs font-medium text-mist-100 transition-colors hover:border-ink-500 hover:bg-ink-700 hover:text-mist-50 disabled:opacity-40 cursor-pointer"
                    >
                      {fetchingModels ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
                      {fetchingModels ? '拉取中…' : '自动获取模型'}
                    </button>
                    <button
                      onClick={() => setShowAddModal(true)}
                      className="flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-750/80 px-2.5 py-1.5 text-xs font-medium text-mist-100 transition-colors hover:border-ink-500 hover:bg-ink-700 hover:text-mist-50 cursor-pointer"
                    >
                      <Plus size={13} />
                      添加模型
                    </button>
                  </div>
                </div>

                {/* 模型卡片列表 */}
                <div className="space-y-2">
                  {currentProvider.models && currentProvider.models.length > 0 ? (
                    currentProvider.models.map((m) => {
                      const testRes = testResults[m.id]
                      const isTesting = testingModelId === m.id

                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between rounded-lg border border-ink-750 bg-ink-900/60 px-4 py-3 transition-colors hover:border-ink-700"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="text-xs font-semibold text-mist-100">{m.name}</span>
                            {m.contextWindow && (
                              <span className="rounded bg-ink-750 px-2 py-0.5 text-[10px] font-medium text-mist-400">
                                {m.contextWindow}
                              </span>
                            )}
                            {m.tags &&
                              m.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded bg-ink-750 px-2 py-0.5 text-[10px] font-medium text-mist-400"
                                >
                                  {tag}
                                </span>
                              ))}
                          </div>

                          <div className="flex items-center gap-3">
                            {/* 连通测试结果显示 */}
                            {testRes && (
                              <div className="flex items-center gap-1 text-[11px]">
                                {testRes.ok ? (
                                  <span className="flex items-center gap-1 text-emerald-400">
                                    <CheckCircle2 size={12} />
                                    {testRes.latencyMs}ms
                                  </span>
                                ) : (
                                  <span
                                    className="flex items-center gap-1 text-rose-400"
                                    title={testRes.error}
                                  >
                                    <XCircle size={12} />
                                    失败
                                  </span>
                                )}
                              </div>
                            )}

                            {/* 测试连接按钮 */}
                            <button
                              onClick={() => void handleTestModel(m.id)}
                              disabled={isTesting || !currentProvider.baseUrl}
                              className="text-mist-500 transition-colors hover:text-mist-200 disabled:opacity-40"
                              title="测试模型连通性与测速"
                            >
                              {isTesting ? <Loader2 size={14} className="animate-spin text-accent" /> : <Zap size={14} />}
                            </button>

                            {/* 编辑按钮 */}
                            <button
                              onClick={() => setEditingModel(m)}
                              className="text-mist-500 transition-colors hover:text-mist-200"
                              title="编辑模型"
                            >
                              <Pencil size={14} />
                            </button>

                            {/* 删除按钮 */}
                            <button
                              onClick={() => {
                                const next = currentProvider.models.filter((item) => item.id !== m.id)
                                updateCurrentProvider({ models: next })
                              }}
                              className="text-mist-500 transition-colors hover:text-rose-400"
                              title="删除模型"
                            >
                              <Trash2 size={14} />
                            </button>

                            {/* 启用/禁用 Toggle */}
                            <label className="relative inline-flex cursor-pointer items-center">
                              <input
                                type="checkbox"
                                checked={m.enabled}
                                onChange={(e) => {
                                  const next = currentProvider.models.map((item) =>
                                    item.id === m.id ? { ...item, enabled: e.target.checked } : item
                                  )
                                  updateCurrentProvider({ models: next })
                                }}
                                className="peer sr-only"
                              />
                              <div className="h-4 w-7 rounded-full bg-ink-600 transition-colors peer-checked:bg-emerald-500 after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-all peer-checked:after:translate-x-3 after:content-['']" />
                            </label>
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-700/60 py-10 px-4 text-center">
                      <p className="text-xs font-medium text-mist-400">当前供应商暂无模型</p>
                      <p className="mt-2 text-[11px] leading-normal text-mist-500">点击上方「自动获取模型」从接口拉取，或「添加模型」手动创建</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center p-8">
            <Bot size={40} className="text-mist-500 mb-3 stroke-[1.5]" />
            <p className="text-sm font-medium text-mist-300">未选择模型供应商</p>
            <p className="mt-1 text-xs text-mist-500">
              请从左侧列表选择供应商，或点击右上角「添加供应商」
            </p>
          </div>
        )}
      </div>

      {/* 选择添加供应商模板模态框 */}
      {showAddProviderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-xl rounded-xl border border-ink-700 bg-ink-850 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-mist-100">选择供应商模板</h3>
                <p className="mt-0.5 text-xs text-mist-400">选择官方预设模板快速接入，或创建空白自定义供应商</p>
              </div>
              <button
                onClick={() => setShowAddProviderModal(false)}
                className="rounded-lg p-1 text-mist-400 hover:bg-ink-750 hover:text-mist-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {OFFICIAL_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => handleSelectTemplate(tpl)}
                  className="flex flex-col items-start rounded-lg border border-ink-750 bg-ink-900/70 p-3.5 text-left transition-all hover:border-ink-600 hover:bg-ink-800/90 cursor-pointer"
                >
                  <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-2">
                      {tpl.id === 'zhipu' ? (
                        <Sparkles size={16} className="text-blue-400" />
                      ) : tpl.id === 'deepseek' ? (
                        <Bot size={16} className="text-sky-400" />
                      ) : tpl.id === 'kimi' ? (
                        <Sparkles size={16} className="text-emerald-400" />
                      ) : tpl.id === 'openai' ? (
                        <Bot size={16} className="text-indigo-400" />
                      ) : (
                        <Box size={16} className="text-mist-300" />
                      )}
                      <span className="text-xs font-semibold text-mist-100">{tpl.name}</span>
                    </div>
                    <span className="rounded bg-ink-750 px-1.5 py-0.5 text-[10px] text-mist-400">官方</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11px] text-mist-400 leading-snug">{tpl.description}</p>
                  <div className="mt-2.5 truncate text-[10px] text-mist-500 font-mono">{tpl.baseUrl}</div>
                </button>
              ))}

              {/* 自定义供应商卡片 */}
              <button
                onClick={() => handleSelectTemplate('custom')}
                className="flex flex-col items-start rounded-lg border border-dashed border-ink-700 bg-ink-900/40 p-3.5 text-left transition-all hover:border-mist-500 hover:bg-ink-800/80 cursor-pointer"
              >
                <div className="flex w-full items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Plus size={16} className="text-mist-200" />
                    <span className="text-xs font-semibold text-mist-100">自定义供应商</span>
                  </div>
                  <span className="rounded bg-ink-750 px-1.5 py-0.5 text-[10px] text-mist-400">自定义</span>
                </div>
                <p className="mt-1.5 text-[11px] text-mist-400 leading-snug">
                  接入任意 OpenAI / Anthropic 兼容的自建或第三方模型中转服务
                </p>
                <div className="mt-2.5 text-[10px] text-mist-500 font-mono">自定义 Base URL & Key</div>
              </button>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setShowAddProviderModal(false)}
                className="rounded-lg px-4 py-2 text-xs font-medium text-mist-400 transition-colors hover:bg-ink-750 hover:text-mist-200"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 手动添加模型模态框 */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
          <div className="w-96 rounded-xl border border-ink-700 bg-ink-850 p-5 shadow-2xl">
            <h3 className="mb-4 text-sm font-semibold text-mist-100">添加模型</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-mist-400">模型 ID (如 gpt-4o, claude-3-7-sonnet)</label>
                <input
                  type="text"
                  value={newModelForm.id}
                  onChange={(e) => setNewModelForm({ ...newModelForm, id: e.target.value })}
                  placeholder="模型标识符"
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">显示名称</label>
                <input
                  type="text"
                  value={newModelForm.name}
                  onChange={(e) => setNewModelForm({ ...newModelForm, name: e.target.value })}
                  placeholder="留空则与 ID 相同"
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">上下文窗口 (如 1M, 128k)</label>
                <input
                  type="text"
                  value={newModelForm.contextWindow}
                  onChange={(e) => setNewModelForm({ ...newModelForm, contextWindow: e.target.value })}
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">标签 (逗号分隔，如 视觉, 代码, 推理)</label>
                <input
                  type="text"
                  value={newModelForm.tags}
                  onChange={(e) => setNewModelForm({ ...newModelForm, tags: e.target.value })}
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="rounded px-3 py-1.5 text-xs text-mist-400 hover:bg-ink-750 hover:text-mist-200"
              >
                取消
              </button>
              <button
                onClick={handleAddCustomModel}
                disabled={!newModelForm.id.trim()}
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑模型模态框 */}
      {editingModel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
          <div className="w-96 rounded-xl border border-ink-700 bg-ink-850 p-5 shadow-2xl">
            <h3 className="mb-4 text-sm font-semibold text-mist-100">编辑模型</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-mist-400">模型 ID</label>
                <input
                  type="text"
                  disabled
                  value={editingModel.id}
                  className="w-full rounded border border-ink-700 bg-ink-900/50 px-3 py-2 text-mist-400 opacity-70"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">显示名称</label>
                <input
                  type="text"
                  value={editingModel.name}
                  onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })}
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">上下文窗口 (如 1M, 128k)</label>
                <input
                  type="text"
                  value={editingModel.contextWindow || ''}
                  onChange={(e) => setEditingModel({ ...editingModel, contextWindow: e.target.value })}
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-mist-400">标签 (逗号分隔)</label>
                <input
                  type="text"
                  value={editingModel.tags?.join(', ') || ''}
                  onChange={(e) =>
                    setEditingModel({
                      ...editingModel,
                      tags: e.target.value
                        .split(/[,，\s]+/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                    })
                  }
                  className="w-full rounded border border-ink-700 bg-ink-900 px-3 py-2 text-mist-100 focus:outline-none"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setEditingModel(null)}
                className="rounded px-3 py-1.5 text-xs text-mist-400 hover:bg-ink-750 hover:text-mist-200"
              >
                取消
              </button>
              <button
                onClick={handleSaveEditedModel}
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-500 cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
