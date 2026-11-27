import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX, type RefObject } from 'react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { getToolBrand } from '@shared/tool-brands'
import type { ConversationDriverOption } from '../../../shared/conversation/driverCatalog'
import { projectRootKey } from '../my/navigation'
import { useApp } from '../store'
import {
  ModelSelectionPanel,
  modelSelectionKey,
  type ModelSelectionAction,
  type ModelSelectionOption,
  type ModelSelectionRuntime,
  type ModelSelectionTuning
} from '../model-selection/ModelSelectionPanel'
import type { ComposerModel } from './useComposerSend'
import {
  isSameComposerModel,
  turnOptionsForModel,
  unavailableModelReason,
  type ConversationModelCatalog
} from './useConversationModelCatalog'
import {
  readModelPickerPreferences,
  recordModelUsed,
  subscribeModelPickerPreferences,
  toggleModelFavorite
} from './modelPickerPreferences'

const INSTANCE_NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  claudeAgent: 'Claude Code',
  opencode: 'OpenCode',
  pi: 'Pi',
  acp: 'ACP',
  gemini: 'Gemini',
  cursor: 'Cursor',
  kiro: 'Kiro'
}

const DRIVER_BRAND_MAP: Readonly<Record<string, string>> = {
  codex: 'codex',
  claudeAgent: 'claude-code',
  claude: 'claude-code',
  opencode: 'opencode',
  pi: 'pi',
  cursor: 'cursor',
  kiro: 'kiro',
  antigravity: 'antigravity',
  gemini: 'gemini-cli'
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: '关',
  none: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  highest: '最高',
  ultra: '极限',
  extreme: '极限',
  default: '默认'
}

const KNOWN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  claude: 'Anthropic',
  google: 'Google',
  'google-vertex': 'Google Vertex',
  gemini: 'Google',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  qwen: 'Qwen',
  dashscope: 'Qwen',
  alibaba: 'Qwen',
  zhipu: '智谱 AI',
  zhipuai: '智谱 AI',
  glm: '智谱 AI',
  moonshot: 'Moonshot',
  kimi: 'Moonshot',
  minimax: 'MiniMax',
  volcengine: '火山方舟',
  ark: '火山方舟',
  doubao: '火山方舟',
  siliconflow: '硅基流动',
  mistral: 'Mistral',
  groq: 'Groq',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  together: 'Together',
  fireworks: 'Fireworks',
  'amazon-bedrock': 'AWS Bedrock',
  bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  'github-copilot': 'GitHub Copilot',
  copilot: 'GitHub Copilot',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  magpie: 'Magpie',
  'cc-switch': 'CC Switch'
}

const GENERIC_MODEL_GROUPS = new Set(['native', 'custom', 'cc-switch', 'magpie'])

function formatProviderName(raw: string, configuredProviders?: ReadonlyMap<string, string>): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const configured = configuredProviders?.get(trimmed) ?? configuredProviders?.get(trimmed.toLowerCase())
  if (configured) return configured
  const known = KNOWN_PROVIDER_LABELS[trimmed.toLowerCase()]
  if (known) return known
  if (/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return trimmed
      .split(/[-_]+/)
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
      .join(' ')
  }
  return trimmed
}

function resolveModelProviderLabel(
  model: { id: string; displayName: string; providerId?: string; group?: string; instanceId: string; driverKind?: string },
  configuredProviders?: ReadonlyMap<string, string>
): string {
  const group = (model.group ?? '').trim()
  const groupLower = group.toLowerCase()
  const providerId = (model.providerId ?? '').trim()
  const displayName = (model.displayName ?? '').trim()

  if (/\s*·\s*routing\s*group$/i.test(displayName)) return '路由组'

  if (group && !GENERIC_MODEL_GROUPS.has(groupLower)) {
    return formatProviderName(group, configuredProviders)
  }

  const ccsCodex = /^ccs-([^/]+)\//i.exec(model.id)
  const ccsClaude = /^ccs-claude-([^-]+)--/i.exec(model.id)
  const ccsKey = ccsCodex?.[1] ?? ccsClaude?.[1]

  if (groupLower === 'magpie' || /magpie/i.test(providerId) || /magpie/i.test(ccsKey ?? '') || /magpie/i.test(model.id)) {
    return 'Magpie'
  }

  if (groupLower === 'cc-switch' || ccsKey) {
    const channel = (providerId && providerId.toLowerCase() !== 'cc-switch' ? providerId : ccsKey) ?? ''
    return channel ? formatProviderName(channel, configuredProviders) : 'CC Switch'
  }

  if (providerId) {
    return formatProviderName(providerId, configuredProviders)
  }

  const slashMatch = /^([^/:]+)\/(.+)$/.exec(model.id)
  if (slashMatch && !/^ccs-/i.test(slashMatch[1])) {
    return formatProviderName(slashMatch[1], configuredProviders)
  }

  const colonIndex = model.id.indexOf(':')
  if (colonIndex > 0) {
    return formatProviderName(model.id.slice(0, colonIndex), configuredProviders)
  }

  if (model.driverKind === 'codex' || model.instanceId === 'codex') return 'OpenAI'
  if (model.driverKind === 'claude' || model.driverKind === 'claudeAgent' || model.instanceId === 'claude' || model.instanceId === 'claudeAgent') return 'Anthropic'
  if (model.driverKind === 'gemini' || model.instanceId === 'gemini') return 'Google'
  return instanceLabel(model.instanceId)
}

const DEFAULT_CHOICE_VALUE = '__default__'
const emptyPreferences = { favorites: [], recent: [] } as const
const emptySnapshot = () => emptyPreferences

function instanceLabel(instanceId: string): string {
  return INSTANCE_NAMES[instanceId] ?? getToolBrand(instanceId)?.label ?? instanceId
}

function resolveDriverBrand(driverKind?: string, instanceId?: string): string | undefined {
  if (driverKind && DRIVER_BRAND_MAP[driverKind]) return DRIVER_BRAND_MAP[driverKind]
  if (driverKind && getToolBrand(driverKind)) return getToolBrand(driverKind)?.id
  if (instanceId && DRIVER_BRAND_MAP[instanceId]) return DRIVER_BRAND_MAP[instanceId]
  if (instanceId && getToolBrand(instanceId)) return getToolBrand(instanceId)?.id
  return undefined
}

function localizeChoiceLabel(label: string, value?: string): string {
  const labelKey = label.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  const valueKey = (value ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  return EFFORT_LABELS[labelKey] ?? EFFORT_LABELS[valueKey] ?? label
}

function modelTurnOptions(catalog: ConversationModelCatalog, model: ComposerModel | null): readonly ConversationDriverOption[] {
  const read = catalog.instances.find((instance) => instance.instanceId === model?.instanceId)?.read
  return model && read?.status === 'ready'
    ? turnOptionsForModel(read.descriptor, model).filter((option) => option.choices.length > 1)
    : []
}

function splitPreferenceKey(key: string): string {
  const separator = key.indexOf('\u0000')
  if (separator < 0) return key
  return modelSelectionKey(key.slice(0, separator), key.slice(separator + 1))
}

function buildTuningItem(
  option: ConversationDriverOption,
  model: ComposerModel,
  disabled: boolean,
  onChange: (next: ComposerModel) => void
): ModelSelectionTuning {
  const rawChosen = model.options?.find((item) => item.id === option.id)?.value
  const chosen = typeof rawChosen === 'string' ? rawChosen : undefined
  const currentDefault = typeof option.current === 'string' && option.choices.some((choice) => choice.value === option.current)
    ? option.current
    : undefined
  const includeDefaultChoice = !currentDefault
  const choices = [
    ...(includeDefaultChoice ? [{ value: DEFAULT_CHOICE_VALUE, label: '默认' }] : []),
    ...option.choices.map((choice) => ({ value: choice.value, label: localizeChoiceLabel(choice.label, choice.value) }))
  ]
  const effectiveValue = chosen ?? currentDefault ?? DEFAULT_CHOICE_VALUE

  return {
    id: option.id,
    label: option.label,
    value: effectiveValue,
    options: choices,
    disabled,
    onChange: (nextValue: string) => {
      const rest = model.options?.filter((item) => item.id !== option.id) ?? []
      const nextOptions = nextValue === DEFAULT_CHOICE_VALUE ? rest : [...rest, { id: option.id, value: nextValue }]
      onChange({ ...model, options: nextOptions.length ? nextOptions : undefined })
    }
  }
}

interface ModelPickerProps {
  readonly catalog: ConversationModelCatalog
  readonly value: ComposerModel | null
  readonly onChange: (model: ComposerModel) => void
  readonly anchor: RefObject<HTMLElement>
  readonly triggerRef?: RefObject<HTMLButtonElement>
  readonly lockedInstanceId?: string
  readonly disabled?: boolean
  /** Favorites and recents are scoped per project root; omitted falls back to panel preferences. */
  readonly root?: string
}

export function ConversationModelPicker({
  catalog,
  value,
  onChange,
  anchor,
  triggerRef,
  lockedInstanceId,
  disabled = false,
  root
}: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [query, setQuery] = useState('')
  const rootKey = projectRootKey(root)

  const subscribe = useCallback(
    (notify: () => void) => (rootKey ? subscribeModelPickerPreferences(rootKey, notify) : () => undefined),
    [rootKey]
  )
  const snapshot = useCallback(
    () => (rootKey ? readModelPickerPreferences(rootKey) : emptyPreferences),
    [rootKey]
  )
  const preferences = useSyncExternalStore(subscribe, snapshot, emptySnapshot)

  const { ensure, status, error, refresh } = catalog
  const instances = useMemo(
    () => catalog.instances.filter((instance) => !lockedInstanceId || instance.instanceId === lockedInstanceId),
    [catalog.instances, lockedInstanceId]
  )
  const searching = query.trim().length > 0
  const needsAllInstances = searching || activeTab === 'all' || activeTab === 'recent' || activeTab === 'favorites'

  useEffect(() => {
    if (!open) return
    const recentInstances = new Set(preferences.recent.map((key) => key.split('\u0000', 1)[0]))
    for (const item of instances) {
      if (needsAllInstances || item.instanceId === activeTab || item.instanceId === value?.instanceId || recentInstances.has(item.instanceId)) {
        void ensure(item.instanceId)
      }
    }
  }, [activeTab, ensure, instances, needsAllInstances, open, preferences.recent, value?.instanceId])

  const runtimes = useMemo<ModelSelectionRuntime[]>(
    () => instances.map((item) => ({
      id: item.instanceId,
      name: instanceLabel(item.instanceId),
      brand: resolveDriverBrand(item.driverKind, item.instanceId)
    })),
    [instances]
  )

  const visibleModels = useMemo(
    () => catalog.models.filter((model) => !lockedInstanceId || model.instanceId === lockedInstanceId),
    [catalog.models, lockedInstanceId]
  )

  const aiProviders = useApp((s) => s.settings?.ai?.providers)
  const configuredProviderMap = useMemo(() => {
    const map = new Map<string, string>()
    if (!aiProviders?.length) return map
    for (const provider of aiProviders) {
      const label = provider.name?.trim()
      if (!label) continue
      map.set(provider.id, label)
      map.set(provider.id.toLowerCase(), label)
    }
    return map
  }, [aiProviders])

  const options = useMemo<ModelSelectionOption[]>(
    () => visibleModels.map((model) => {
      const reason = unavailableModelReason(catalog, model)
      return {
        runtimeId: model.instanceId,
        modelId: model.id,
        name: model.displayName,
        brand: resolveDriverBrand(model.driverKind, model.instanceId),
        providerLabel: resolveModelProviderLabel(model, configuredProviderMap),
        sourceLabel: instanceLabel(model.instanceId),
        disabled: Boolean(reason),
        disabledReason: reason
      }
    }),
    [catalog, configuredProviderMap, visibleModels]
  )

  const recentKeys = useMemo(
    () => (rootKey ? preferences.recent.map(splitPreferenceKey) : undefined),
    [preferences.recent, rootKey]
  )
  const favoriteKeys = useMemo(
    () => (rootKey ? preferences.favorites.map(splitPreferenceKey) : undefined),
    [preferences.favorites, rootKey]
  )

  const activeInstance = instances.find((item) => item.instanceId === activeTab)
  const activeRead = activeInstance?.read
  const loading = status === 'loading' || status === 'idle' || (needsAllInstances
    ? instances.some((item) => !item.read || item.read.status === 'loading')
    : Boolean(activeInstance && (!activeRead || activeRead.status === 'loading')))

  const activeError = error ?? (
    !needsAllInstances && activeRead?.status === 'failed'
      ? activeRead.error
      : !needsAllInstances && activeRead?.status === 'ready' && activeRead.descriptor.actions.chat.state === 'unsupported'
        ? activeRead.descriptor.actions.chat.detail
        : undefined
  )

  const turnOptions = useMemo(() => modelTurnOptions(catalog, value), [catalog, value])
  const { primaryTuning, extraTunings } = useMemo(() => {
    if (!value || turnOptions.length === 0) return { primaryTuning: undefined, extraTunings: [] as ModelSelectionTuning[] }
    const reasoning = turnOptions.find((option) => option.category === 'reasoning') ?? turnOptions[0]
    const rest = turnOptions.filter((option) => option !== reasoning)
    return {
      primaryTuning: buildTuningItem(reasoning, value, disabled, onChange),
      extraTunings: rest.map((option) => buildTuningItem(option, value, disabled, onChange))
    }
  }, [disabled, onChange, turnOptions, value])

  const selectedInstance = instances.find((item) => item.instanceId === value?.instanceId)
  const triggerBrand = value ? resolveDriverBrand(selectedInstance?.driverKind, value.instanceId) : undefined
  const triggerLabel = value ? (cleanModelDisplayName(value.displayName, value.instanceId) || value.displayName) : '选择模型'
  const triggerDescription = value
    ? `当前模型：${triggerLabel}，来源：${instanceLabel(value.instanceId)}`
    : '尚未选择可用模型'

  const recoveryActions = useMemo<ModelSelectionAction[]>(
    () => [{
      key: 'refresh',
      label: '重新读取',
      loading,
      disabled: loading,
      onClick: () => {
        void refresh(true)
        if (activeInstance) {
          void ensure(activeInstance.instanceId, true)
        } else {
          for (const item of instances) void ensure(item.instanceId, true)
        }
      }
    }],
    [activeInstance, ensure, instances, loading, refresh]
  )

  return (
    <ModelSelectionPanel
      disabled={disabled}
      triggerRef={triggerRef}
      positionAnchorRef={anchor}
      triggerLabel={triggerLabel}
      triggerDescription={triggerDescription}
      triggerBrand={triggerBrand}
      runtimes={runtimes}
      options={options}
      selectedRuntimeId={value?.instanceId}
      selectedModelId={value?.id}
      selected={Boolean(value)}
      recentKeys={recentKeys}
      favoriteKeys={favoriteKeys}
      onToggleFavorite={rootKey
        ? (option) => { if (option.modelId) toggleModelFavorite(rootKey, option.runtimeId, option.modelId) }
        : undefined}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen && catalog.status !== 'loading') void refresh()
      }}
      onActiveTabChange={setActiveTab}
      onQueryChange={setQuery}
      onSelect={(option, close) => {
        const picked = visibleModels.find((item) => item.instanceId === option.runtimeId && item.id === option.modelId)
        if (!picked) return
        if (rootKey) recordModelUsed(rootKey, picked.instanceId, picked.id)
        if (!isSameComposerModel(value, picked)) onChange(picked)
        close()
      }}
      onOpenModelSettings={() => useApp.getState().setPage('models')}
      tuning={primaryTuning}
      extraTunings={extraTunings}
      loading={loading}
      errorText={activeError}
      emptyText={activeInstance ? '这个实例暂无可用模型' : '暂无已配置的模型实例。'}
      recoveryActions={recoveryActions}
    />
  )
}
