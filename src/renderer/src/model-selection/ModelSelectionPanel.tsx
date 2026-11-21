import { useId, useMemo, useState, type JSX, type ReactNode, type Ref, type RefObject } from 'react'
import { Check, ChevronDown, History, LayoutGrid, Loader2, Search, Settings2, SlidersHorizontal, Star } from 'lucide-react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Dropdown } from '../my/ui'
import './model-selection-panel.css'

const STORAGE_RECENT_KEY = 'my_recent_models'
const STORAGE_FAVORITES_KEY = 'my_favorite_models'

export interface ModelSelectionOption {
  runtimeId: string
  modelId?: string
  name: string
  brand?: string
  disabled?: boolean
}

export interface ModelSelectionRuntime {
  id: string
  name: string
  brand?: string
}

export interface ModelSelectionAction {
  key: string
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

export interface ModelSelectionTuning {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  onChange: (value: string) => void
}

interface RecentModelItem {
  modelId: string
  runtimeId: string
  timestamp: number
}

function loadRecentModels(): RecentModelItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveRecentModel(modelId: string, runtimeId: string): void {
  try {
    const next = [
      { modelId, runtimeId, timestamp: Date.now() },
      ...loadRecentModels().filter((item) => item.modelId !== modelId || item.runtimeId !== runtimeId)
    ].slice(0, 10)
    localStorage.setItem(STORAGE_RECENT_KEY, JSON.stringify(next))
  } catch {
    // Preferences remain unavailable when browser storage is blocked.
  }
}

function loadFavorites(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_FAVORITES_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveFavorites(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_FAVORITES_KEY, JSON.stringify(ids))
  } catch {
    // Preferences remain unavailable when browser storage is blocked.
  }
}

function modelKey(runtimeId: string, modelId?: string): string {
  return `${runtimeId}:${modelId ?? ''}`
}

export function ModelSelectionPanel({
  triggerLabel,
  triggerDescription,
  triggerBrand,
  triggerLoading = false,
  disabled = false,
  triggerRef,
  positionAnchorRef,
  runtimes,
  options,
  selectedRuntimeId,
  selectedModelId,
  selected = false,
  onSelect,
  defaultAction,
  onOpenModelSettings,
  onOpenRuntimeSettings,
  tuning,
  emptyText = '暂无可用的模型',
  loading = false,
  recoveryActions = []
}: {
  triggerLabel: string
  triggerDescription: string
  triggerBrand?: string
  triggerLoading?: boolean
  disabled?: boolean
  triggerRef?: Ref<HTMLButtonElement>
  positionAnchorRef?: RefObject<HTMLElement | null>
  runtimes: ModelSelectionRuntime[]
  options: ModelSelectionOption[]
  selectedRuntimeId?: string
  selectedModelId?: string
  selected?: boolean
  onSelect: (option: ModelSelectionOption, close: () => void) => void
  defaultAction?: ReactNode
  onOpenModelSettings?: () => void
  onOpenRuntimeSettings?: () => void
  tuning?: ModelSelectionTuning
  emptyText?: string
  loading?: boolean
  recoveryActions?: ModelSelectionAction[]
}): JSX.Element | null {
  const [activeTab, setActiveTab] = useState('all')
  const [query, setQuery] = useState('')
  const [recentList, setRecentList] = useState<RecentModelItem[]>(loadRecentModels)
  const [favorites, setFavorites] = useState<string[]>(loadFavorites)
  const [tuningOpen, setTuningOpen] = useState(false)
  const descriptionId = useId()
  const tuningId = useId()
  const hasFooterActions = Boolean(defaultAction || onOpenModelSettings || onOpenRuntimeSettings || recoveryActions.length > 0 || triggerLoading)

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredOptions = useMemo(() => {
    let result = options
    if (activeTab === 'recent') {
      result = recentList
        .map((item) => options.find((option) => option.runtimeId === item.runtimeId && option.modelId === item.modelId))
        .filter((option): option is ModelSelectionOption => Boolean(option))
    } else if (activeTab === 'favorites') {
      result = options.filter((option) => option.modelId && favorites.includes(modelKey(option.runtimeId, option.modelId)))
    } else if (activeTab !== 'all') {
      result = options.filter((option) => option.runtimeId === activeTab)
    }

    if (normalizedQuery) {
      result = result.filter((option) => `${option.name} ${option.modelId ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    }
    return result
  }, [activeTab, favorites, normalizedQuery, options, recentList])

  const toggleFavorite = (key: string): void => {
    const next = favorites.includes(key) ? favorites.filter((value) => value !== key) : [...favorites, key]
    setFavorites(next)
    saveFavorites(next)
  }

  return (
    <Dropdown
      placement="top"
      align="right"
      width={340}
      gap={8}
      layoutKey={loading ? 'loading' : `${runtimes.length}:${options.length}`}
      disabled={disabled}
      positionAnchorRef={positionAnchorRef}
      trigger={({ toggle, open }) => (
        <button
          ref={triggerRef}
          type="button"
          className="acp-composer-context acp-model-trigger my-composer-control acp-unified-picker-pill"
          aria-expanded={open}
          aria-haspopup="true"
          aria-label="选择模型"
          aria-describedby={descriptionId}
          onClick={() => {
            if (!open) {
              setQuery('')
              setActiveTab('all')
              setRecentList(loadRecentModels())
              setFavorites(loadFavorites())
              setTuningOpen(false)
            }
            toggle()
          }}
        >
          {triggerLoading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
          {triggerBrand && <ToolBrandIcon brand={triggerBrand} size={14} className="acp-unified-trigger-icon" />}
          <span className="acp-unified-pill-text">{triggerLabel}</span>
          <span id={descriptionId} className="sr-only">{triggerDescription}</span>
          <ChevronDown size={11} className="opacity-60" aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <div className="acp-unified-picker-panel">
          <div className="acp-unified-picker-header">
            <div className="acp-unified-search-box">
              <Search size={13} className="acp-unified-search-icon" aria-hidden="true" />
              <input
                type="text"
                className="acp-unified-search-input"
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="acp-unified-picker-body">
            <nav className="acp-unified-picker-rail" aria-label="模型分类与执行引擎">
              <button type="button" className={`acp-unified-rail-btn${activeTab === 'recent' ? ' is-active' : ''}`} title="最近使用" aria-label="最近使用" aria-pressed={activeTab === 'recent'} onClick={() => setActiveTab('recent')}><History size={15} /></button>
              <button type="button" className={`acp-unified-rail-btn${activeTab === 'favorites' ? ' is-active' : ''}`} title="收藏模型" aria-label="收藏模型" aria-pressed={activeTab === 'favorites'} onClick={() => setActiveTab('favorites')}><Star size={15} /></button>
              <button type="button" className={`acp-unified-rail-btn${activeTab === 'all' ? ' is-active' : ''}`} title="全部模型" aria-label="全部模型" aria-pressed={activeTab === 'all'} onClick={() => setActiveTab('all')}><LayoutGrid size={15} /></button>
              <div className="acp-unified-rail-divider" aria-hidden="true" />
              {runtimes.map((runtime) => (
                <button
                  key={runtime.id}
                  type="button"
                  className={`acp-unified-rail-btn${activeTab === runtime.id ? ' is-active' : ''}`}
                  title={runtime.name}
                  aria-label={runtime.name}
                  aria-pressed={activeTab === runtime.id}
                  onClick={() => setActiveTab(runtime.id)}
                >
                  <ToolBrandIcon brand={runtime.brand ?? runtime.id} size={15} />
                </button>
              ))}
            </nav>

            <div className="acp-unified-picker-content my-scrollbar">
              <div className="acp-unified-content-header">
                <span className="acp-unified-section-title">
                  {normalizedQuery
                    ? `匹配结果 (${filteredOptions.length})`
                    : activeTab === 'recent'
                      ? '最近使用'
                      : activeTab === 'favorites'
                        ? '我的收藏'
                        : activeTab === 'all'
                          ? '全部模型'
                          : runtimes.find((runtime) => runtime.id === activeTab)?.name ?? '执行引擎'}
                </span>
              </div>

              {loading ? (
                <div role="status" className="acp-unified-state"><Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /><span>加载中…</span></div>
              ) : filteredOptions.length === 0 ? (
                <div className="acp-unified-empty-state"><p>{normalizedQuery ? '未找到匹配的模型' : activeTab === 'recent' ? '暂无最近使用的模型' : activeTab === 'favorites' ? '暂无收藏模型' : emptyText}</p></div>
              ) : (
                <ul className="acp-unified-model-list" aria-label="模型">
                  {filteredOptions.map((option) => {
                    const key = modelKey(option.runtimeId, option.modelId)
                    const isSelected = selected && option.runtimeId === selectedRuntimeId && option.modelId === selectedModelId
                    const isStarred = favorites.includes(key)
                    const label = option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name
                    return (
                      <li key={key}>
                        <div className={`acp-unified-model-row${isSelected ? ' is-selected' : ''}`}>
                          <button
                            type="button"
                            className="acp-unified-model-select"
                            aria-current={isSelected ? 'true' : undefined}
                            aria-disabled={option.disabled || undefined}
                            onClick={() => { if (!option.disabled) onSelect(option, close) }}
                          >
                            <span className="acp-unified-model-icon"><ToolBrandIcon brand={option.brand ?? option.runtimeId} size={14} /></span>
                            <span className="acp-unified-model-name-group">
                              <span className="acp-unified-model-title" title={option.name}>{label}</span>
                            </span>
                            {isSelected && <Check size={13} className="acp-unified-check-icon" aria-hidden="true" />}
                          </button>
                          {option.modelId && <div className="acp-unified-model-actions">
                            <button
                              type="button"
                              className={`acp-unified-star-btn${isStarred ? ' is-starred' : ''}`}
                              title={isStarred ? '取消收藏' : '添加收藏'}
                              aria-label={isStarred ? `取消收藏 ${label}` : `收藏 ${label}`}
                              aria-pressed={isStarred}
                              onClick={() => toggleFavorite(key)}
                            >
                              <Star size={13} fill={isStarred ? 'currentColor' : 'none'} aria-hidden="true" />
                            </button>
                            {tuning && isSelected && (
                              <button
                                type="button"
                                className="acp-unified-tune-btn"
                                aria-label={`${tuning.label}：${label}`}
                                aria-expanded={tuningOpen}
                                aria-controls={tuningOpen ? tuningId : undefined}
                                onClick={() => setTuningOpen((open) => !open)}
                              >
                                <SlidersHorizontal size={13} aria-hidden="true" />
                              </button>
                            )}
                          </div>}
                        </div>
                        {tuning && isSelected && tuningOpen && (
                          <div id={tuningId} className="acp-unified-tuning-panel">
                            <span className="acp-unified-tuning-header">{tuning.label}</span>
                            <div className="acp-unified-tuning-options" role="group" aria-label={tuning.label}>
                              {tuning.options.map((choice) => (
                                <button
                                  key={choice.value}
                                  type="button"
                                  aria-pressed={choice.value === tuning.value}
                                  aria-label={`${tuning.label} ${choice.label}`}
                                  disabled={tuning.disabled}
                                  onClick={() => tuning.onChange(choice.value)}
                                >
                                  {choice.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {hasFooterActions && <div className="acp-unified-picker-footer">
            {onOpenModelSettings && (
              <button type="button" className="acp-unified-footer-btn acp-unified-model-settings" onClick={() => { close(); onOpenModelSettings() }}>
                <Settings2 size={12} aria-hidden="true" /><span>配置模型</span>
              </button>
            )}
            {onOpenRuntimeSettings && (
              <button type="button" className="acp-unified-footer-btn" onClick={() => { close(); onOpenRuntimeSettings() }}>
                <span>管理执行引擎</span>
              </button>
            )}
            {triggerLoading && <div role="status" className="acp-unified-panel-progress"><Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" /><span>更新中…</span></div>}
            {recoveryActions.map((action) => (
              <button key={action.key} type="button" className="acp-unified-footer-btn" disabled={action.disabled || action.loading} onClick={() => action.onClick()}>
                {action.loading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
                <span>{action.label}</span>
              </button>
            ))}
            {defaultAction}
          </div>}
        </div>
      )}
    </Dropdown>
  )
}
