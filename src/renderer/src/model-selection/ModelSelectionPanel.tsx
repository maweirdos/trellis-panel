import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { Check, ChevronDown, History, LayoutGrid, Loader2, Search, Settings2, SlidersHorizontal, Sparkles, Star } from 'lucide-react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { EFFORT_TRACK_TONES, findEffortStyleOption, useIsDarkTheme } from '../components/effort/effort-catalog'
import { EffortDetentFader, EffortStylePickerPopover } from '../components/effort/EffortDetentFader'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { useCollaborationPlatform } from '../crux/collaboration-platform-store'
import { Dropdown } from '../my/ui'
import './model-selection-panel.css'

const STORAGE_RECENT_KEY = 'my_recent_models'
const STORAGE_FAVORITES_KEY = 'my_favorite_models'

export interface ModelSelectionOption {
  runtimeId: string
  modelId?: string
  name: string
  brand?: string
  /** Optional secondary source label shown only to disambiguate same-named models across runtimes. */
  sourceLabel?: string
  disabled?: boolean
  disabledReason?: string
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
  id?: string
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

export function modelSelectionKey(runtimeId: string, modelId?: string): string {
  return `${runtimeId}:${modelId ?? ''}`
}

function tuningGlyphLevel(options: readonly { value: string; label: string }[], value?: string, label?: string): 0 | 1 | 2 | 3 {
  const probe = `${value ?? ''} ${label ?? ''}`.toLowerCase()
  if (/\b(off|none|disabled)\b|关|关闭/.test(probe)) return 0
  if (/\b(xhigh|max|highest|ultra|extreme)\b|极高|超高|最高|极限/.test(probe)) return 3
  if (/\bhigh\b|高/.test(probe)) return 3
  if (/\b(medium|med|normal|balanced|default)\b|中|默认/.test(probe)) return 2
  if (/\b(low|min|minimal)\b|低|最低/.test(probe)) return 1
  const index = options.findIndex((opt) => opt.value === value)
  if (index < 0 || options.length <= 1) return 1
  const ratio = index / (options.length - 1)
  return ratio >= 0.67 ? 3 : ratio >= 0.34 ? 2 : 1
}

function rankModelSearch(
  options: readonly ModelSelectionOption[],
  runtimes: readonly ModelSelectionRuntime[],
  rawQuery: string
): ModelSelectionOption[] {
  const normalized = rawQuery.trim().toLocaleLowerCase()
  if (!normalized) return [...options]
  const tokens = normalized.split(/\s+/u)
  const runtimeNames = new Map(runtimes.map((runtime) => [runtime.id, runtime.name.toLocaleLowerCase()]))
  return options
    .flatMap((option, order) => {
      const displayName = (option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name).toLocaleLowerCase()
      const fields = [
        displayName,
        option.name.toLocaleLowerCase(),
        option.modelId?.toLocaleLowerCase() ?? '',
        option.sourceLabel?.toLocaleLowerCase() ?? '',
        option.runtimeId.toLocaleLowerCase(),
        runtimeNames.get(option.runtimeId) ?? ''
      ].filter(Boolean)
      if (displayName === normalized) return [{ option, order, score: -1000 }]
      let score = 0
      for (const token of tokens) {
        const index = fields.findIndex((field) => field.includes(token))
        if (index < 0) return []
        score += index * 10 + (fields[index]?.startsWith(token) ? 0 : 4)
      }
      return [{ option, order, score }]
    })
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map((entry) => entry.option)
}

function PanelUnmountSync({ onUnmount }: { onUnmount?: () => void }): null {
  const ref = useRef(onUnmount)
  ref.current = onUnmount
  useEffect(() => () => ref.current?.(), [])
  return null
}

function TuningControls({
  tunings,
  tuningId
}: {
  tunings: readonly ModelSelectionTuning[]
  tuningId: string
}): JSX.Element {
  return (
    <div id={tuningId} className="acp-unified-tuning-panel">
      {tunings.map((item, idx) => (
        <div key={item.id ?? `${item.label}:${idx}`} className="acp-unified-tuning-group">
          <span className="acp-unified-tuning-header">{item.label}</span>
          <div className="acp-unified-tuning-options" role="group" aria-label={item.label}>
            {item.options.map((choice) => (
              <button
                key={choice.value}
                type="button"
                aria-pressed={choice.value === item.value}
                aria-label={`${item.label} ${choice.label}`}
                disabled={item.disabled}
                onClick={() => item.onChange(choice.value)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TriggerControl({
  open,
  disabled,
  triggerRef,
  triggerLabel,
  triggerDescription,
  triggerBrand,
  triggerLoading,
  descriptionId,
  tuning,
  onToggle
}: {
  open: boolean
  disabled: boolean
  triggerRef?: Ref<HTMLButtonElement>
  triggerLabel: string
  triggerDescription: string
  triggerBrand?: string
  triggerLoading: boolean
  descriptionId: string
  tuning?: ModelSelectionTuning
  onToggle: () => void
}): JSX.Element {
  if (tuning && tuning.options.length > 0) {
    const currentChoice = tuning.options.find((opt) => opt.value === tuning.value) ?? tuning.options[0]
    const shortLabel = currentChoice?.label ?? ''
    const glyphLevel = tuningGlyphLevel(tuning.options, currentChoice?.value, shortLabel)
    return (
      <div
        className="acp-model-trigger my-composer-control acp-split-trigger-pill"
        aria-expanded={open}
        data-disabled={disabled ? 'true' : undefined}
      >
        <button
          ref={triggerRef}
          type="button"
          className="acp-split-trigger-left"
          disabled={disabled}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="选择模型"
          aria-describedby={descriptionId}
          onClick={onToggle}
        >
          {triggerLoading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
          {triggerBrand && <ToolBrandIcon brand={triggerBrand} size={14} className="acp-unified-trigger-icon" />}
          <span className="acp-unified-pill-text">{triggerLabel}</span>
          <span id={descriptionId} className="sr-only">{triggerDescription}</span>
        </button>
        <span className="acp-split-trigger-divider" aria-hidden="true" />
        <div className="acp-split-trigger-right-wrap">
          <button
            type="button"
            className="acp-split-trigger-right"
            disabled={disabled}
            aria-haspopup="true"
            aria-expanded={open}
            aria-label={`${tuning.label}：${shortLabel}，点击展开`}
            onClick={onToggle}
          >
            <span className="acp-eff-glyph" aria-hidden="true">
              <i className={glyphLevel >= 1 ? 'on' : undefined} />
              <i className={glyphLevel >= 2 ? 'on' : undefined} />
              <i className={glyphLevel >= 3 ? 'on' : undefined} />
            </span>
            <span>{shortLabel}</span>
            <ChevronDown size={10} className="opacity-60" aria-hidden="true" />
          </button>
          {!open && !disabled && (
            <div className="acp-quick-ruler" role="group" aria-label={`快捷调整${tuning.label}`}>
              {tuning.options.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className="acp-quick-ruler-btn"
                  aria-pressed={choice.value === tuning.value}
                  disabled={tuning.disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    tuning.onChange(choice.value)
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      className="acp-model-trigger my-composer-control acp-unified-picker-pill"
      aria-expanded={open}
      aria-haspopup="true"
      aria-label="选择模型"
      aria-describedby={descriptionId}
      onClick={onToggle}
    >
      {triggerLoading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
      {triggerBrand && <ToolBrandIcon brand={triggerBrand} size={14} className="acp-unified-trigger-icon" />}
      <span className="acp-unified-pill-text">{triggerLabel}</span>
      <span id={descriptionId} className="sr-only">{triggerDescription}</span>
      <ChevronDown size={11} className="opacity-60" aria-hidden="true" />
    </button>
  )
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
  recentKeys,
  favoriteKeys,
  onToggleFavorite,
  onOpenChange,
  onActiveTabChange,
  onQueryChange,
  defaultAction,
  onOpenModelSettings,
  onOpenRuntimeSettings,
  tuning,
  extraTunings = [],
  emptyText = '暂无可用的模型',
  errorText,
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
  runtimes: readonly ModelSelectionRuntime[]
  options: readonly ModelSelectionOption[]
  selectedRuntimeId?: string
  selectedModelId?: string
  selected?: boolean
  onSelect: (option: ModelSelectionOption, close: () => void) => void
  recentKeys?: readonly string[]
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (option: ModelSelectionOption) => void
  onOpenChange?: (open: boolean) => void
  onActiveTabChange?: (tab: string) => void
  onQueryChange?: (query: string) => void
  defaultAction?: ReactNode
  onOpenModelSettings?: () => void
  onOpenRuntimeSettings?: () => void
  tuning?: ModelSelectionTuning
  extraTunings?: readonly ModelSelectionTuning[]
  emptyText?: string
  errorText?: string
  loading?: boolean
  recoveryActions?: readonly ModelSelectionAction[]
}): JSX.Element {
  const [activeTab, setActiveTab] = useState('all')
  const [query, setQuery] = useState('')
  const [recentList, setRecentList] = useState<RecentModelItem[]>(loadRecentModels)
  const [localFavorites, setLocalFavorites] = useState<string[]>(loadFavorites)
  const [tuningOpen, setTuningOpen] = useState(false)
  const [effortHover, setEffortHover] = useState<{ label: string; isPeak: boolean } | null>(null)
  const descriptionId = useId()
  const tuningId = useId()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const isDarkTheme = useIsDarkTheme()
  const effortEmblemStyle = useCollaborationPlatform((s) => s.effortEmblemStyle)
  const effortTrackTone = useCollaborationPlatform((s) => s.effortTrackTone)
  const setEffortEmblemStyle = useCollaborationPlatform((s) => s.setEffortEmblemStyle)
  const setEffortTrackTone = useCollaborationPlatform((s) => s.setEffortTrackTone)

  const activeTuning = tuning && tuning.options.length > 0 ? tuning : undefined
  const inlineTunings = useMemo(
    () => [activeTuning, ...extraTunings.filter((item) => item.options.length > 0)].filter((item): item is ModelSelectionTuning => Boolean(item)),
    [activeTuning, extraTunings]
  )
  const favorites = favoriteKeys ?? localFavorites
  const hasFooterActions = Boolean(defaultAction || onOpenModelSettings || onOpenRuntimeSettings || recoveryActions.length > 0 || triggerLoading)
  const selectedTuningIndex = activeTuning
    ? Math.max(0, activeTuning.options.findIndex((opt) => opt.value === activeTuning.value))
    : 0
  const currentTuningChoice = activeTuning?.options[selectedTuningIndex] ?? activeTuning?.options[0]
  const effortToneSpec = EFFORT_TRACK_TONES[effortTrackTone] ?? EFFORT_TRACK_TONES.obsidian
  const effortToneAccent = isDarkTheme ? effortToneSpec.accentDark : effortToneSpec.accentLight
  const tuningReadoutLabel = effortHover?.label ?? currentTuningChoice?.label ?? ''
  const tuningReadoutPeak = effortHover
    ? effortHover.isPeak
    : Boolean(activeTuning && activeTuning.options.length > 1 && selectedTuningIndex === activeTuning.options.length - 1)

  const switchTab = (tab: string): void => {
    setActiveTab(tab)
    onActiveTabChange?.(tab)
  }

  const updateQuery = (nextQuery: string): void => {
    setQuery(nextQuery)
    onQueryChange?.(nextQuery)
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const optionByKey = useMemo(
    () => new Map(options.map((option) => [modelSelectionKey(option.runtimeId, option.modelId), option])),
    [options]
  )
  const filteredOptions = useMemo(() => {
    let scoped: readonly ModelSelectionOption[] = options
    if (!normalizedQuery) {
      if (activeTab === 'recent') {
        const keys = recentKeys ?? recentList.map((item) => modelSelectionKey(item.runtimeId, item.modelId))
        scoped = keys.map((key) => optionByKey.get(key)).filter((option): option is ModelSelectionOption => Boolean(option))
      } else if (activeTab === 'favorites') {
        scoped = options.filter((option) => option.modelId && favorites.includes(modelSelectionKey(option.runtimeId, option.modelId)))
      } else if (activeTab !== 'all') {
        scoped = options.filter((option) => option.runtimeId === activeTab)
      }
    }
    return rankModelSearch(scoped, runtimes, query)
  }, [activeTab, favorites, normalizedQuery, optionByKey, options, query, recentKeys, recentList, runtimes])

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const option of filteredOptions) {
      const display = option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name
      counts.set(display, (counts.get(display) ?? 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name))
  }, [filteredOptions])

  const handleToggleFavorite = (option: ModelSelectionOption): void => {
    if (onToggleFavorite) {
      onToggleFavorite(option)
      return
    }
    const key = modelSelectionKey(option.runtimeId, option.modelId)
    const next = localFavorites.includes(key) ? localFavorites.filter((value) => value !== key) : [...localFavorites, key]
    setLocalFavorites(next)
    saveFavorites(next)
  }

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.altKey || event.metaKey || !(event.target instanceof HTMLElement)) return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.acp-unified-model-select:not([aria-disabled="true"])') ?? [])]
    const fromSearch = event.target === searchInputRef.current
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (event.key === 'Enter' && fromSearch && buttons.length > 0) {
      event.preventDefault()
      buttons[0]?.click()
      return
    }
    if ((!fromSearch && index < 0) || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || buttons.length === 0) return
    event.preventDefault()
    const next = fromSearch
      ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }

  const sectionHeading = normalizedQuery
    ? `匹配结果 (${filteredOptions.length})`
    : activeTab === 'recent'
      ? '最近使用'
      : activeTab === 'favorites'
        ? '我的收藏'
        : activeTab === 'all'
          ? '全部模型'
          : runtimes.find((runtime) => runtime.id === activeTab)?.name ?? '执行引擎'

  const emptyMessage = normalizedQuery
    ? '未找到匹配的模型'
    : activeTab === 'recent'
      ? '暂无最近使用的模型'
      : activeTab === 'favorites'
        ? '暂无收藏模型'
        : emptyText

  return (
    <Dropdown
      placement="top"
      align="right"
      width={348}
      gap={8}
      layoutKey={loading ? 'loading' : `${runtimes.length}:${options.length}:${inlineTunings.length}`}
      disabled={disabled}
      positionAnchorRef={positionAnchorRef}
      className="min-w-0"
      trigger={({ toggle, open }) => {
        const handleToggle = (): void => {
          const nextOpen = !open
          if (nextOpen) {
            setQuery('')
            onQueryChange?.('')
            const initialTab = runtimes.length === 1 ? runtimes[0].id : 'all'
            setActiveTab(initialTab)
            onActiveTabChange?.(initialTab)
            if (!recentKeys) setRecentList(loadRecentModels())
            if (!favoriteKeys) setLocalFavorites(loadFavorites())
            setTuningOpen(false)
            setEffortHover(null)
          }
          onOpenChange?.(nextOpen)
          toggle()
        }
        return (
          <TriggerControl
            open={open}
            disabled={disabled}
            triggerRef={triggerRef}
            triggerLabel={triggerLabel}
            triggerDescription={triggerDescription}
            triggerBrand={triggerBrand}
            triggerLoading={triggerLoading}
            descriptionId={descriptionId}
            tuning={activeTuning}
            onToggle={handleToggle}
          />
        )
      }}
    >
      {(close) => {
        const closePanel = (): void => {
          onOpenChange?.(false)
          close()
        }
        return (
          <div className="acp-unified-picker-panel" onKeyDown={handlePanelKeyDown}>
            <PanelUnmountSync onUnmount={() => onOpenChange?.(false)} />
            <div className="acp-unified-picker-header">
              <div className="acp-unified-search-box">
                <Search size={13} className="acp-unified-search-icon" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="acp-unified-search-input"
                  aria-label="搜索模型"
                  placeholder="搜索模型"
                  value={query}
                  onChange={(event) => updateQuery(event.target.value)}
                  autoFocus
                />
              </div>
            </div>

            <div className="acp-unified-picker-body">
              <nav className="acp-unified-picker-rail" aria-label="模型分类与执行引擎">
                <button type="button" className={`acp-unified-rail-btn${activeTab === 'recent' ? ' is-active' : ''}`} title="最近使用" aria-label="最近使用" aria-pressed={activeTab === 'recent'} onClick={() => switchTab('recent')}><History size={15} /></button>
                <button type="button" className={`acp-unified-rail-btn${activeTab === 'favorites' ? ' is-active' : ''}`} title="收藏模型" aria-label="收藏模型" aria-pressed={activeTab === 'favorites'} onClick={() => switchTab('favorites')}><Star size={15} /></button>
                <button type="button" className={`acp-unified-rail-btn${activeTab === 'all' ? ' is-active' : ''}`} title="全部模型" aria-label="全部模型" aria-pressed={activeTab === 'all'} onClick={() => switchTab('all')}><LayoutGrid size={15} /></button>
                {runtimes.length > 0 && <div className="acp-unified-rail-divider" aria-hidden="true" />}
                {runtimes.map((runtime) => (
                  <button
                    key={runtime.id}
                    type="button"
                    className={`acp-unified-rail-btn${activeTab === runtime.id ? ' is-active' : ''}`}
                    title={runtime.name}
                    aria-label={runtime.name}
                    aria-pressed={activeTab === runtime.id}
                    onClick={() => switchTab(runtime.id)}
                  >
                    <ToolBrandIcon brand={runtime.brand ?? runtime.id} size={15} />
                  </button>
                ))}
              </nav>

              <div className="acp-unified-picker-content my-scrollbar">
                <div className="acp-unified-content-header">
                  <span className="acp-unified-section-title">{sectionHeading}</span>
                </div>

                {loading && filteredOptions.length === 0 ? (
                  <div role="status" className="acp-unified-state"><Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /><span>正在读取模型…</span></div>
                ) : errorText && filteredOptions.length === 0 ? (
                  <div role="status" className="acp-unified-state"><span>{errorText}</span></div>
                ) : filteredOptions.length === 0 ? (
                  <div className="acp-unified-empty-state"><p>{emptyMessage}</p></div>
                ) : (
                  <ul ref={listRef} className="acp-unified-model-list" aria-label="模型">
                    {filteredOptions.map((option) => {
                      const key = modelSelectionKey(option.runtimeId, option.modelId)
                      const isSelected = selected && option.runtimeId === selectedRuntimeId && option.modelId === selectedModelId
                      const isStarred = favorites.includes(key)
                      const label = option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name
                      const showSource = Boolean(option.sourceLabel && duplicateNames.has(label))
                      return (
                        <li key={key}>
                          <div className={`acp-unified-model-row${isSelected ? ' is-selected' : ''}`} data-testid="model-row">
                            <button
                              type="button"
                              className="acp-unified-model-select"
                              aria-current={isSelected ? 'true' : undefined}
                              aria-disabled={option.disabled || undefined}
                              title={option.disabledReason ?? (option.sourceLabel ? `${label} · ${option.sourceLabel}` : option.name)}
                              onClick={() => {
                                if (option.disabled) return
                                if (!recentKeys && option.modelId) saveRecentModel(option.modelId, option.runtimeId)
                                onSelect(option, closePanel)
                              }}
                            >
                              <span className="acp-unified-model-icon"><ToolBrandIcon brand={option.brand ?? option.runtimeId} size={14} /></span>
                              <span className="acp-unified-model-name-group">
                                <span className="acp-unified-model-title">{label}</span>
                                {showSource && <span className="acp-unified-model-source">{option.sourceLabel}</span>}
                              </span>
                              {option.disabled && <span className="acp-unified-model-badge">不可用</span>}
                              {isSelected && <Check size={13} className="acp-unified-check-icon" aria-hidden="true" />}
                            </button>
                            {option.modelId && (
                              <div className="acp-unified-model-actions">
                                <button
                                  type="button"
                                  className={`acp-unified-star-btn${isStarred ? ' is-starred' : ''}`}
                                  title={isStarred ? '取消收藏' : '添加收藏'}
                                  aria-label={isStarred ? `取消收藏 ${label}` : `收藏 ${label}`}
                                  aria-pressed={isStarred}
                                  disabled={Boolean(option.disabled) && !isStarred}
                                  onClick={() => handleToggleFavorite(option)}
                                >
                                  <Star size={13} fill={isStarred ? 'currentColor' : 'none'} aria-hidden="true" />
                                </button>
                                {inlineTunings.length > 0 && isSelected && (
                                  <button
                                    type="button"
                                    className="acp-unified-tune-btn"
                                    title={inlineTunings[0].label}
                                    aria-label={`${inlineTunings[0].label}：${label}`}
                                    aria-expanded={tuningOpen}
                                    aria-controls={tuningOpen ? tuningId : undefined}
                                    onClick={() => setTuningOpen((prev) => !prev)}
                                  >
                                    <SlidersHorizontal size={13} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          {inlineTunings.length > 0 && isSelected && tuningOpen && (
                            <TuningControls tunings={inlineTunings} tuningId={tuningId} />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>

            {activeTuning && (
              <div
                className="acp-unified-tuning-dock"
                style={{ '--mc-tone-accent': effortToneAccent } as JSX.IntrinsicElements['div']['style']}
              >
                <div className="acp-unified-tuning-dock-head">
                  <div className="acp-unified-tuning-dock-title">
                    <span>{activeTuning.label}</span>
                    <Dropdown
                      placement="top"
                      align="left"
                      width={304}
                      gap={6}
                      className="inline-flex"
                      trigger={({ toggle, open }) => (
                        <button
                          type="button"
                          className="ef-quiet-trigger"
                          aria-expanded={open}
                          aria-haspopup="menu"
                          aria-label={`自定义${activeTuning.label}滑块样式（当前：${findEffortStyleOption(effortEmblemStyle).name}）`}
                          title={`滑块样式：${findEffortStyleOption(effortEmblemStyle).name}（也可在设置 → 外观预览）`}
                          onClick={toggle}
                        >
                          <Sparkles size={12} aria-hidden="true" />
                        </button>
                      )}
                    >
                      {(closeStyleMenu) => (
                        <EffortStylePickerPopover
                          emblemStyle={effortEmblemStyle}
                          trackTone={effortTrackTone}
                          isDark={isDarkTheme}
                          onSelectStyle={setEffortEmblemStyle}
                          onSelectTone={setEffortTrackTone}
                          onClose={closeStyleMenu}
                        />
                      )}
                    </Dropdown>
                  </div>
                  <span
                    className={`mc-kreadout is-active acp-unified-tuning-readout${effortHover ? ' is-preview' : ''}${tuningReadoutPeak ? ' is-peak' : ''}`}
                  >
                    {tuningReadoutLabel}
                  </span>
                </div>
                <EffortDetentFader
                  modelName={triggerLabel}
                  ariaLabel={activeTuning.label}
                  choices={activeTuning.options}
                  selectedIndex={selectedTuningIndex}
                  active={!activeTuning.disabled}
                  disabled={Boolean(activeTuning.disabled)}
                  emblemStyle={effortEmblemStyle}
                  trackTone={effortTrackTone}
                  isDark={isDarkTheme}
                  onSelect={(nextValue) => activeTuning.onChange(nextValue)}
                  onHoverPreview={(label, isPeak) => setEffortHover(label ? { label, isPeak } : null)}
                />
              </div>
            )}

            {hasFooterActions && (
              <div className="acp-unified-picker-footer">
                {onOpenModelSettings && (
                  <button type="button" className="acp-unified-footer-btn acp-unified-model-settings" onClick={() => { closePanel(); onOpenModelSettings() }}>
                    <Settings2 size={12} aria-hidden="true" /><span>配置模型</span>
                  </button>
                )}
                {onOpenRuntimeSettings && (
                  <button type="button" className="acp-unified-footer-btn" onClick={() => { closePanel(); onOpenRuntimeSettings() }}>
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
              </div>
            )}
          </div>
        )
      }}
    </Dropdown>
  )
}
