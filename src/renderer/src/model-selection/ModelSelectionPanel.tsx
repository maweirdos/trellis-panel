import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, History, LayoutGrid, Loader2, Palette, RefreshCw, Search, Settings2, SlidersHorizontal, Star, X } from 'lucide-react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { EFFORT_TRACK_TONES, findEffortStyleOption, isClassicMinimalStyle, useIsDarkTheme } from '../components/effort/effort-catalog'
import { EffortDetentFader, EffortStylePickerPopover } from '../components/effort/EffortDetentFader'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { useCollaborationPlatform, type EffortEmblemStyle, type EffortTrackTone } from '../crux/collaboration-platform-store'
import { MOTION_POP_EXIT_MS, usePresence } from '../my/motion'
import { Dropdown, Tooltip } from '../my/ui'
import { useEscLayer } from '../utils/use-esc-layer'
import './model-selection-panel.css'

const STORAGE_RECENT_KEY = 'my_recent_models'
const STORAGE_FAVORITES_KEY = 'my_favorite_models'
const OUTER_EFFORT_WIDTH = 312
const OUTER_HOVER_OPEN_MS = 160
const OUTER_HOVER_CLOSE_MS = 220

export interface ModelSelectionOption {
  runtimeId: string
  modelId?: string
  name: string
  brand?: string
  /** Optional provider/supplier name used to group models cleanly. */
  providerLabel?: string
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
        option.providerLabel?.toLocaleLowerCase() ?? '',
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

/* ---------------- 共享思考强度滑块区块（弹窗内部与外层快选共用一套外观与交互） ---------------- */

function EffortTuningSection({
  tuning,
  modelName,
  emblemStyle,
  trackTone,
  isDark,
  onSelectStyle,
  onSelectTone,
  styleAnchorRef,
  onStyleMenuOpenChange,
  onDragStateChange,
  className
}: {
  tuning: ModelSelectionTuning
  modelName: string
  emblemStyle: EffortEmblemStyle
  trackTone: EffortTrackTone
  isDark: boolean
  onSelectStyle: (style: EffortEmblemStyle) => void
  onSelectTone: (tone: EffortTrackTone) => void
  styleAnchorRef?: RefObject<HTMLElement | null>
  onStyleMenuOpenChange?: (open: boolean) => void
  onDragStateChange?: (dragging: boolean) => void
  className: string
}): JSX.Element {
  const [effortHover, setEffortHover] = useState<{ label: string; isPeak: boolean } | null>(null)
  const selectedIndex = Math.max(0, tuning.options.findIndex((opt) => opt.value === tuning.value))
  const currentChoice = tuning.options[selectedIndex] ?? tuning.options[0]
  const toneSpec = EFFORT_TRACK_TONES[trackTone] ?? EFFORT_TRACK_TONES.obsidian
  const toneAccent = isDark ? toneSpec.accentDark : toneSpec.accentLight
  const currentStyleMeta = findEffortStyleOption(emblemStyle)
  const showReadout = !isClassicMinimalStyle(emblemStyle)
  const readoutLabel = effortHover?.label ?? currentChoice?.label ?? ''
  const readoutPeak = effortHover
    ? effortHover.isPeak
    : tuning.options.length > 1 && selectedIndex === tuning.options.length - 1

  return (
    <div
      className={className}
      style={{ '--mc-tone-accent': toneAccent } as JSX.IntrinsicElements['div']['style']}
    >
      <div className="acp-unified-tuning-dock-head">
        <div className="acp-unified-tuning-dock-title">
          <span className="acp-unified-tuning-label">{tuning.label}</span>
          <Dropdown
            placement="left"
            align="right"
            width={316}
            gap={8}
            positionAnchorRef={styleAnchorRef}
            onOpenChange={onStyleMenuOpenChange}
            className="inline-flex"
            trigger={({ toggle, open }) => (
              <Tooltip label={`滑块外观：${currentStyleMeta.name}`} side="top">
                <button
                  type="button"
                  className="ef-quiet-trigger"
                  aria-expanded={open}
                  aria-haspopup="menu"
                  aria-label={`自定义${tuning.label}滑块外观（当前：${currentStyleMeta.name}）`}
                  onClick={toggle}
                >
                  <Palette size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          >
            {(closeStyleMenu) => (
              <EffortStylePickerPopover
                emblemStyle={emblemStyle}
                trackTone={trackTone}
                isDark={isDark}
                onSelectStyle={onSelectStyle}
                onSelectTone={onSelectTone}
                onClose={closeStyleMenu}
              />
            )}
          </Dropdown>
        </div>
        {showReadout && (
          <span
            className={`mc-kreadout is-active acp-unified-tuning-readout${effortHover ? ' is-preview' : ''}${readoutPeak ? ' is-peak' : ''}`}
          >
            {readoutLabel}
          </span>
        )}
      </div>
      <EffortDetentFader
        modelName={modelName}
        ariaLabel={tuning.label}
        choices={tuning.options}
        selectedIndex={selectedIndex}
        active={!tuning.disabled}
        disabled={Boolean(tuning.disabled)}
        emblemStyle={emblemStyle}
        trackTone={trackTone}
        isDark={isDark}
        onSelect={(nextValue) => tuning.onChange(nextValue)}
        onHoverPreview={(label, isPeak) => setEffortHover(label ? { label, isPeak } : null)}
        onDragStateChange={onDragStateChange}
      />
    </div>
  )
}

/* ---------------- 外层分体触发器 + 同款雕塑滑块快选弹层 ---------------- */

function SplitTriggerWithEffortPopover({
  modelMenuOpen,
  disabled,
  triggerRef,
  triggerLabel,
  triggerDescription,
  triggerBrand,
  triggerLoading,
  descriptionId,
  tuning,
  emblemStyle,
  trackTone,
  isDark,
  onSelectStyle,
  onSelectTone,
  onToggleModelMenu
}: {
  modelMenuOpen: boolean
  disabled: boolean
  triggerRef?: Ref<HTMLButtonElement>
  triggerLabel: string
  triggerDescription: string
  triggerBrand?: string
  triggerLoading: boolean
  descriptionId: string
  tuning: ModelSelectionTuning
  emblemStyle: EffortEmblemStyle
  trackTone: EffortTrackTone
  isDark: boolean
  onSelectStyle: (style: EffortEmblemStyle) => void
  onSelectTone: (tone: EffortTrackTone) => void
  onToggleModelMenu: () => void
}): JSX.Element {
  const pillRef = useRef<HTMLDivElement | null>(null)
  const rightBtnRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const lockedSideRef = useRef<'top' | 'bottom' | null>(null)
  const keyboardOpenedRef = useRef(false)
  const escId = useId()

  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [styleMenuOpen, setStyleMenuOpen] = useState(false)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null)
  const lastPosRef = useRef<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null)
  const lastRootRef = useRef<HTMLElement | null>(null)

  const outerOpen = !modelMenuOpen && !disabled && (pinned || hoverOpen || dragging || styleMenuOpen)
  const presence = usePresence(outerOpen, MOTION_POP_EXIT_MS)

  if (pos) lastPosRef.current = pos
  if (portalRoot) lastRootRef.current = portalRoot
  const renderedPos = outerOpen ? pos : lastPosRef.current
  const renderedRoot = outerOpen ? portalRoot : lastRootRef.current

  const clearTimers = useCallback((): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const closeOuter = useCallback((restoreFocus = false): void => {
    clearTimers()
    keyboardOpenedRef.current = false
    setPinned(false)
    setHoverOpen(false)
    setDragging(false)
    setStyleMenuOpen(false)
    if (restoreFocus) {
      window.requestAnimationFrame(() => rightBtnRef.current?.focus({ preventScroll: true }))
    }
  }, [clearTimers])

  useEffect(() => clearTimers, [clearTimers])

  useEffect(() => {
    if (modelMenuOpen || disabled) closeOuter(false)
  }, [closeOuter, disabled, modelMenuOpen])

  useEscLayer(outerOpen, {
    kind: 'modal',
    id: `outer-effort-${escId}`,
    onClose: () => closeOuter(true)
  })

  useLayoutEffect(() => {
    if (!outerOpen) {
      lockedSideRef.current = null
      setPos(null)
      setPortalRoot(null)
      return
    }
    setPortalRoot(pillRef.current?.closest<HTMLElement>('.my-root') ?? null)
  }, [outerOpen])

  useLayoutEffect(() => {
    if (!outerOpen || !portalRoot) return
    const pill = pillRef.current
    const pop = popoverRef.current
    if (!pill || !pop) return

    const update = (allowReFlip: boolean): void => {
      const anchorRect = pill.getBoundingClientRect()
      if (anchorRect.width === 0 && anchorRect.height === 0) {
        closeOuter(false)
        return
      }
      const headerEl = portalRoot.querySelector<HTMLElement>('.my-window-header')
      const headerBottom = headerEl ? Math.ceil(headerEl.getBoundingClientRect().bottom) : 0
      const safeTop = headerBottom > 0 ? Math.max(8, headerBottom + 8) : 8
      const gap = 8
      const popH = pop.offsetHeight
      const popW = pop.offsetWidth || Math.min(OUTER_EFFORT_WIDTH, innerWidth - 16)
      const roomAbove = Math.max(0, anchorRect.top - gap - safeTop)
      const roomBelow = Math.max(0, innerHeight - anchorRect.bottom - gap - 8)

      let side = lockedSideRef.current
      if (!side) {
        side = roomAbove >= popH || roomAbove >= roomBelow ? 'top' : 'bottom'
        lockedSideRef.current = side
      } else if (allowReFlip) {
        if (side === 'top' && roomAbove < popH && roomBelow > roomAbove) {
          side = 'bottom'
          lockedSideRef.current = side
        } else if (side === 'bottom' && roomBelow < popH && roomAbove > roomBelow) {
          side = 'top'
          lockedSideRef.current = side
        }
      }

      const rawTop = side === 'top' ? anchorRect.top - popH - gap : anchorRect.bottom + gap
      const top = Math.max(safeTop, Math.min(rawTop, innerHeight - popH - 8))
      const rawLeft = anchorRect.right - popW
      const left = Math.max(8, Math.min(rawLeft, innerWidth - popW - 8))
      setPos((old) => (old && old.top === top && old.left === left && old.side === side ? old : { top, left, side }))
    }

    update(false)
    const onResize = (): void => update(true)
    const onScroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !pop.contains(event.target)) update(true)
    }
    const observer = new ResizeObserver(() => update(false))
    observer.observe(pop)
    observer.observe(pill)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [closeOuter, outerOpen, portalRoot])

  useEffect(() => {
    if (!outerOpen || !pos || !keyboardOpenedRef.current) return
    keyboardOpenedRef.current = false
    const slider = popoverRef.current?.querySelector<HTMLElement>('[role="slider"]')
    slider?.focus({ preventScroll: true })
  }, [outerOpen, pos])

  useEffect(() => {
    if (!outerOpen) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rightBtnRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.ef-popover')) return
      closeOuter(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [closeOuter, outerOpen])

  const scheduleHoverOpen = (): void => {
    if (modelMenuOpen || disabled) return
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (outerOpen) return
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setHoverOpen(true)
    }, OUTER_HOVER_OPEN_MS)
  }

  const scheduleHoverClose = (): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (pinned || dragging || styleMenuOpen) return
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setHoverOpen(false)
    }, OUTER_HOVER_CLOSE_MS)
  }

  const cancelHoverClose = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const currentChoice = tuning.options.find((opt) => opt.value === tuning.value) ?? tuning.options[0]
  const shortLabel = currentChoice?.label ?? ''
  const glyphLevel = tuningGlyphLevel(tuning.options, currentChoice?.value, shortLabel)
  const toneSpec = EFFORT_TRACK_TONES[trackTone] ?? EFFORT_TRACK_TONES.obsidian
  const toneAccent = isDark ? toneSpec.accentDark : toneSpec.accentLight

  return (
    <div
      ref={pillRef}
      className="acp-model-trigger my-composer-control acp-split-trigger-pill"
      aria-expanded={modelMenuOpen || outerOpen}
      data-disabled={disabled ? 'true' : undefined}
      style={{ '--mc-tone-accent': toneAccent } as JSX.IntrinsicElements['div']['style']}
    >
      <button
        ref={triggerRef}
        type="button"
        className="acp-split-trigger-left"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={modelMenuOpen}
        aria-label="选择模型"
        aria-describedby={descriptionId}
        onClick={() => {
          closeOuter(false)
          onToggleModelMenu()
        }}
      >
        {triggerLoading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
        {triggerBrand && <ToolBrandIcon brand={triggerBrand} size={14} className="acp-unified-trigger-icon" />}
        <span className="acp-unified-pill-text">{triggerLabel}</span>
        <span id={descriptionId} className="sr-only">{triggerDescription}</span>
      </button>
      <span className="acp-split-trigger-divider" aria-hidden="true" />
      <div
        className="acp-split-trigger-right-wrap"
        onMouseEnter={scheduleHoverOpen}
        onMouseLeave={scheduleHoverClose}
      >
        <button
          ref={rightBtnRef}
          type="button"
          className="acp-split-trigger-right"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={outerOpen}
          aria-label={`${tuning.label}：${shortLabel}，点击或悬停调节`}
          onClick={(event) => {
            event.stopPropagation()
            clearTimers()
            if (modelMenuOpen) {
              onToggleModelMenu()
              setPinned(true)
              return
            }
            if (pinned) {
              closeOuter(false)
            } else {
              setPinned(true)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault()
                event.stopPropagation()
              }
              keyboardOpenedRef.current = true
              if (modelMenuOpen) onToggleModelMenu()
              setPinned(true)
            }
          }}
        >
          <span className="acp-eff-glyph" aria-hidden="true">
            <i className={glyphLevel >= 1 ? 'on' : undefined} />
            <i className={glyphLevel >= 2 ? 'on' : undefined} />
            <i className={glyphLevel >= 3 ? 'on' : undefined} />
          </span>
          <span>{shortLabel}</span>
          <ChevronDown
            size={10}
            className={`acp-split-trigger-chevron${outerOpen ? ' is-open' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>

      {presence.mounted && renderedRoot && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`调节${tuning.label}`}
          data-placement={renderedPos?.side}
          data-align="right"
          data-state={presence.state}
          aria-hidden={presence.state === 'closing' || undefined}
          style={{
            top: renderedPos?.top ?? -9999,
            left: renderedPos?.left ?? -9999,
            width: `min(${OUTER_EFFORT_WIDTH}px, calc(100vw - 16px))`,
            visibility: renderedPos ? 'visible' : 'hidden'
          }}
          className={`my-menu no-drag fixed acp-outer-effort-popover${renderedPos ? ' my-pop' : ''}`}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        >
          <EffortTuningSection
            tuning={tuning}
            modelName={triggerLabel}
            emblemStyle={emblemStyle}
            trackTone={trackTone}
            isDark={isDark}
            onSelectStyle={onSelectStyle}
            onSelectTone={onSelectTone}
            styleAnchorRef={popoverRef}
            onStyleMenuOpenChange={setStyleMenuOpen}
            onDragStateChange={setDragging}
            className="acp-outer-effort-body"
          />
        </div>,
        renderedRoot
      )}
    </div>
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
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const descriptionId = useId()
  const tuningId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isDarkTheme = useIsDarkTheme()
  const effortEmblemStyle = useCollaborationPlatform((s) => s.effortEmblemStyle)
  const effortTrackTone = useCollaborationPlatform((s) => s.effortTrackTone)
  const setEffortEmblemStyle = useCollaborationPlatform((s) => s.setEffortEmblemStyle)
  const setEffortTrackTone = useCollaborationPlatform((s) => s.setEffortTrackTone)

  const activeTuning = tuning && tuning.options.length > 0 ? tuning : undefined
  const secondaryTunings = useMemo(
    () => extraTunings.filter((item) => item.options.length > 0),
    [extraTunings]
  )
  const favorites = favoriteKeys ?? localFavorites
  const hasRecoveryRow = Boolean(defaultAction || onOpenModelSettings || onOpenRuntimeSettings || recoveryActions.length > 0)

  const switchTab = (tab: string): void => {
    setActiveTab(tab)
    setCollapsedGroups(new Set())
    onActiveTabChange?.(tab)
  }

  const updateQuery = (nextQuery: string): void => {
    setQuery(nextQuery)
    setCollapsedGroups(new Set())
    onQueryChange?.(nextQuery)
  }

  const toggleGroup = (groupKey: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
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

  const runtimeNameMap = useMemo(
    () => new Map(runtimes.map((runtime) => [runtime.id, runtime.name])),
    [runtimes]
  )

  const providerGroups = useMemo(() => {
    const groups: { key: string; label: string; items: ModelSelectionOption[] }[] = []
    const byKey = new Map<string, { key: string; label: string; items: ModelSelectionOption[] }>()
    for (const option of filteredOptions) {
      const label = option.providerLabel?.trim() || runtimeNameMap.get(option.runtimeId) || option.sourceLabel?.trim() || '其他'
      const key = label.toLocaleLowerCase()
      let group = byKey.get(key)
      if (!group) {
        group = { key, label, items: [] }
        byKey.set(key, group)
        groups.push(group)
      }
      group.items.push(option)
    }
    return groups
  }, [filteredOptions, runtimeNameMap])

  const sectionHeading = normalizedQuery
    ? '匹配结果'
    : activeTab === 'recent'
      ? '最近使用'
      : activeTab === 'favorites'
        ? '我的收藏'
        : activeTab === 'all'
          ? '全部模型'
          : runtimes.find((runtime) => runtime.id === activeTab)?.name ?? '执行引擎'

  const useProviderGrouping =
    !(activeTab === 'recent' && !normalizedQuery) &&
    (providerGroups.length > 1 ||
      (providerGroups.length === 1 &&
        providerGroups[0].label.toLocaleLowerCase() !== sectionHeading.toLocaleLowerCase()))

  const isSingleRuntimeTab = !normalizedQuery && activeTab !== 'all' && activeTab !== 'recent' && activeTab !== 'favorites'
  const showRowBrandIcon = !isSingleRuntimeTab && runtimes.length > 1

  const showContentHeader =
    !useProviderGrouping ||
    Boolean(normalizedQuery) ||
    activeTab === 'favorites' ||
    triggerLoading ||
    loading ||
    filteredOptions.length === 0

  const ambiguousSourceKeys = useMemo(() => {
    const runtimesByScopeAndName = new Map<string, Set<string>>()
    const buckets = useProviderGrouping
      ? providerGroups.map((group) => ({ scope: group.key, items: group.items }))
      : [{ scope: '', items: filteredOptions }]
    for (const bucket of buckets) {
      for (const option of bucket.items) {
        const display = option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name
        const scopeKey = `${bucket.scope}\0${display}`
        let set = runtimesByScopeAndName.get(scopeKey)
        if (!set) {
          set = new Set()
          runtimesByScopeAndName.set(scopeKey, set)
        }
        set.add(option.runtimeId)
      }
    }
    return new Set(
      [...runtimesByScopeAndName.entries()]
        .filter(([, runtimeSet]) => runtimeSet.size > 1)
        .map(([scopeKey]) => scopeKey)
    )
  }, [filteredOptions, providerGroups, useProviderGrouping])

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

  const emptyMessage = normalizedQuery
    ? '未找到匹配的模型'
    : activeTab === 'recent'
      ? '暂无最近使用的模型'
      : activeTab === 'favorites'
        ? '暂无收藏模型'
        : emptyText

  return (
    <Dropdown
      placement="bottom"
      align="right"
      width={368}
      gap={8}
      layoutKey={loading ? 'loading' : `${runtimes.length}:${options.length}:${secondaryTunings.length}:${Boolean(activeTuning)}`}
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
            setCollapsedGroups(new Set())
          }
          onOpenChange?.(nextOpen)
          toggle()
        }

        if (activeTuning) {
          return (
            <SplitTriggerWithEffortPopover
              modelMenuOpen={open}
              disabled={disabled}
              triggerRef={triggerRef}
              triggerLabel={triggerLabel}
              triggerDescription={triggerDescription}
              triggerBrand={triggerBrand}
              triggerLoading={triggerLoading}
              descriptionId={descriptionId}
              tuning={activeTuning}
              emblemStyle={effortEmblemStyle}
              trackTone={effortTrackTone}
              isDark={isDarkTheme}
              onSelectStyle={setEffortEmblemStyle}
              onSelectTone={setEffortTrackTone}
              onToggleModelMenu={handleToggle}
            />
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
            onClick={handleToggle}
          >
            {triggerLoading && <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />}
            {triggerBrand && <ToolBrandIcon brand={triggerBrand} size={14} className="acp-unified-trigger-icon" />}
            <span className="acp-unified-pill-text">{triggerLabel}</span>
            <span id={descriptionId} className="sr-only">{triggerDescription}</span>
            <ChevronDown size={11} className="opacity-60" aria-hidden="true" />
          </button>
        )
      }}
    >
      {(close) => {
        const closePanel = (): void => {
          onOpenChange?.(false)
          close()
        }
        const renderModelRow = (option: ModelSelectionOption, groupKey = ''): JSX.Element => {
          const key = modelSelectionKey(option.runtimeId, option.modelId)
          const isSelected = selected && option.runtimeId === selectedRuntimeId && option.modelId === selectedModelId
          const isStarred = favorites.includes(key)
          const label = option.modelId ? cleanModelDisplayName(option.name, option.runtimeId) : option.name
          const showSource = Boolean(option.sourceLabel && ambiguousSourceKeys.has(`${groupKey}\0${label}`))
          const titleMeta = [option.providerLabel, option.sourceLabel]
            .filter((part): part is string => Boolean(part))
            .filter((part, idx, arr) => arr.findIndex((p) => p.toLocaleLowerCase() === part.toLocaleLowerCase()) === idx)
            .join(' · ')
          const rowTitle = option.disabledReason ?? (titleMeta ? `${label} · ${titleMeta}` : option.name)
          const selectClass = showRowBrandIcon
            ? 'acp-unified-model-select'
            : groupKey
              ? 'acp-unified-model-select is-iconless-grouped'
              : 'acp-unified-model-select is-iconless'
          return (
            <li key={key}>
              <div className={`acp-unified-model-row${isSelected ? ' is-selected' : ''}`} data-testid="model-row">
                <button
                  type="button"
                  className={selectClass}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-disabled={option.disabled || undefined}
                  title={rowTitle}
                  onClick={() => {
                    if (option.disabled) return
                    if (!recentKeys && option.modelId) saveRecentModel(option.modelId, option.runtimeId)
                    onSelect(option, closePanel)
                  }}
                >
                  {showRowBrandIcon && (
                    <span className="acp-unified-model-icon"><ToolBrandIcon brand={option.brand ?? option.runtimeId} size={15} /></span>
                  )}
                  <span className="acp-unified-model-name-group">
                    <span className="acp-unified-model-title">{label}</span>
                    {showSource && <span className="acp-unified-model-source">{option.sourceLabel}</span>}
                  </span>
                  {option.disabled && <span className="acp-unified-model-badge">不可用</span>}
                </button>
                {(option.modelId || isSelected) && (
                  <div className="acp-unified-model-actions">
                    {option.modelId && (
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
                    )}
                    {option.modelId && secondaryTunings.length > 0 && isSelected && (
                      <button
                        type="button"
                        className="acp-unified-tune-btn"
                        title={secondaryTunings[0].label}
                        aria-label={`${secondaryTunings[0].label}：${label}`}
                        aria-expanded={tuningOpen}
                        aria-controls={tuningOpen ? tuningId : undefined}
                        onClick={() => setTuningOpen((prev) => !prev)}
                      >
                        <SlidersHorizontal size={13} aria-hidden="true" />
                      </button>
                    )}
                    {isSelected && (
                      <span className="acp-unified-check-slot" aria-hidden="true">
                        <Check size={14} className="acp-unified-check-icon" />
                      </span>
                    )}
                  </div>
                )}
              </div>
              {secondaryTunings.length > 0 && isSelected && tuningOpen && (
                <TuningControls tunings={secondaryTunings} tuningId={tuningId} />
              )}
            </li>
          )
        }
        return (
          <div ref={panelRef} className="acp-unified-picker-panel" onKeyDown={handlePanelKeyDown}>
            <PanelUnmountSync onUnmount={() => onOpenChange?.(false)} />
            <div className="acp-unified-picker-header">
              <div className="acp-unified-search-box">
                <Search size={13} className="acp-unified-search-icon" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="acp-unified-search-input"
                  aria-label="搜索模型"
                  placeholder="搜索模型或供应商…"
                  value={query}
                  onChange={(event) => updateQuery(event.target.value)}
                  autoFocus
                />
                {query && (
                  <button
                    type="button"
                    className="acp-unified-search-clear"
                    aria-label="清空搜索"
                    onClick={() => {
                      updateQuery('')
                      searchInputRef.current?.focus({ preventScroll: true })
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
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

              <div className="acp-unified-picker-content">
                {showContentHeader && (
                  <div className="acp-unified-content-header">
                    <span className="acp-unified-section-title">{sectionHeading}</span>
                    <div className="acp-unified-content-meta">
                      {triggerLoading && (
                        <span role="status" className="acp-unified-panel-progress" aria-label="正在更新模型列表">
                          <Loader2 size={11} className="acp-progress-spinner" aria-hidden="true" />
                        </span>
                      )}
                      {!loading && filteredOptions.length > 0 && (
                        <span className="acp-unified-section-count">{filteredOptions.length}</span>
                      )}
                    </div>
                  </div>
                )}

                {loading && filteredOptions.length === 0 ? (
                  <div role="status" className="acp-unified-state"><Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /><span>正在读取模型…</span></div>
                ) : errorText && filteredOptions.length === 0 ? (
                  <div role="status" className="acp-unified-state is-column">
                    <span>{errorText}</span>
                    {hasRecoveryRow && (
                      <div className="acp-unified-state-actions">
                        {onOpenModelSettings && (
                          <button type="button" className="acp-unified-footer-btn" onClick={() => { closePanel(); onOpenModelSettings() }}>
                            <Settings2 size={12} aria-hidden="true" /><span>配置模型</span>
                          </button>
                        )}
                        {onOpenRuntimeSettings && (
                          <button type="button" className="acp-unified-footer-btn" onClick={() => { closePanel(); onOpenRuntimeSettings() }}>
                            <span>管理执行引擎</span>
                          </button>
                        )}
                        {recoveryActions.map((action) => (
                          <button key={action.key} type="button" className="acp-unified-footer-btn" disabled={action.disabled || action.loading} onClick={() => action.onClick()}>
                            {action.loading
                              ? <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />
                              : action.key === 'refresh'
                                ? <RefreshCw size={12} aria-hidden="true" />
                                : null}
                            <span>{action.label}</span>
                          </button>
                        ))}
                        {defaultAction}
                      </div>
                    )}
                  </div>
                ) : filteredOptions.length === 0 ? (
                  <div className="acp-unified-empty-state is-column">
                    <p>{emptyMessage}</p>
                    {!normalizedQuery && activeTab === 'all' && hasRecoveryRow && (
                      <div className="acp-unified-state-actions">
                        {onOpenModelSettings && (
                          <button type="button" className="acp-unified-footer-btn" onClick={() => { closePanel(); onOpenModelSettings() }}>
                            <Settings2 size={12} aria-hidden="true" /><span>配置模型</span>
                          </button>
                        )}
                        {onOpenRuntimeSettings && (
                          <button type="button" className="acp-unified-footer-btn" onClick={() => { closePanel(); onOpenRuntimeSettings() }}>
                            <span>管理执行引擎</span>
                          </button>
                        )}
                        {recoveryActions.map((action) => (
                          <button key={action.key} type="button" className="acp-unified-footer-btn" disabled={action.disabled || action.loading} onClick={() => action.onClick()}>
                            {action.loading
                              ? <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" />
                              : action.key === 'refresh'
                                ? <RefreshCw size={12} aria-hidden="true" />
                                : null}
                            <span>{action.label}</span>
                          </button>
                        ))}
                        {defaultAction}
                      </div>
                    )}
                  </div>
                ) : useProviderGrouping ? (
                  <div ref={listRef} className="acp-unified-provider-groups">
                    {providerGroups.map((group) => {
                      const isCollapsed = collapsedGroups.has(group.key)
                      return (
                        <section key={group.key} className="acp-unified-provider-group" aria-label={group.label}>
                          <button
                            type="button"
                            className="acp-unified-provider-header"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleGroup(group.key)}
                          >
                            <ChevronDown
                              size={11}
                              className={`acp-unified-provider-chevron${isCollapsed ? ' is-collapsed' : ''}`}
                              aria-hidden="true"
                            />
                            <span className="acp-unified-provider-name">{group.label}</span>
                            <span className="acp-unified-provider-count">{group.items.length}</span>
                          </button>
                          {!isCollapsed && (
                            <ul className="acp-unified-model-list" aria-label={group.label}>
                              {group.items.map((option) => renderModelRow(option, group.key))}
                            </ul>
                          )}
                        </section>
                      )
                    })}
                  </div>
                ) : (
                  <div ref={listRef}>
                    <ul className="acp-unified-model-list" aria-label="模型">
                      {filteredOptions.map((option) => renderModelRow(option))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {activeTuning && (
              <EffortTuningSection
                tuning={activeTuning}
                modelName={triggerLabel}
                emblemStyle={effortEmblemStyle}
                trackTone={effortTrackTone}
                isDark={isDarkTheme}
                onSelectStyle={setEffortEmblemStyle}
                onSelectTone={setEffortTrackTone}
                styleAnchorRef={panelRef}
                className="acp-unified-tuning-dock"
              />
            )}
          </div>
        )
      }}
    </Dropdown>
  )
}
