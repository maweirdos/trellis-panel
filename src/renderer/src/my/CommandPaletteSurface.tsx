// 全应用共享命令面板骨架：分类滑动页签 + 实体钻取胶囊 + 平滑高度过渡 + 分离式右侧悬浮预览卡。
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Command, CornerDownLeft, Search, X } from 'lucide-react'
import { useEscLayer } from '../utils/use-esc-layer'
import { prefersReducedMotion } from './motion'
import { Modal, Tabs } from './ui'

export interface CommandPalettePreview {
  /** 顶部类型微标，如「团队任务」「AI Agent」「空间」「页面导航」「快捷操作」 */
  eyebrow: string
  /** 顶部右侧编号或短状态，如 MAIN-1 / 已启用 */
  code?: string
  /** 图标或头像 */
  icon?: ReactNode
  /** 主标题 */
  title: string
  /** 摘要说明 */
  summary?: string
  /** 结构化属性键值对 */
  meta?: Array<{ label: string; value: ReactNode }>
  /** 底部提示 */
  footerHint?: string
}

export interface CommandPaletteDrilldown {
  label: string
  icon?: ReactNode
  placeholder?: string
  actions: CommandPaletteItem[]
}

export interface CommandPaletteCategory {
  id: string
  label: string
}

export interface CommandPaletteItem {
  id: string
  category: string
  section: string
  label: string
  subtitle?: string
  icon: ReactNode
  badge?: ReactNode
  hint?: string
  actionVerb?: string
  keywords?: string
  /** 全文匹配域（如任务描述），仅正文未命中而描述命中时显示「描述命中」角标 */
  fulltext?: string
  preview?: CommandPalettePreview
  drilldown?: CommandPaletteDrilldown
  run: () => void
}

const MAX_RESULTS_PX = 380
const PREVIEW_DEBOUNCE_MS = 70

function matchTokens(item: CommandPaletteItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = `${item.label} ${item.subtitle ?? ''} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.fulltext ?? ''}`.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function isDescriptionOnlyMatch(item: CommandPaletteItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q || !item.fulltext) return false
  const primary = `${item.label} ${item.subtitle ?? ''} ${item.keywords ?? ''}`.toLowerCase()
  const tokens = q.split(/\s+/).filter(Boolean)
  return !tokens.every((token) => primary.includes(token)) && tokens.every((token) => item.fulltext!.toLowerCase().includes(token))
}

export function CommandPaletteSurface({
  open,
  onClose,
  ariaLabel,
  placeholder = '搜索任务、空间、Agent 或输入命令…',
  categories,
  items,
  maxVisible = 60,
  emptyHint = '尝试更换关键词，或切换上方分类'
}: {
  open: boolean
  onClose: () => void
  ariaLabel: string
  placeholder?: string
  categories: CommandPaletteCategory[]
  items: CommandPaletteItem[]
  maxVisible?: number
  emptyHint?: string
}): JSX.Element {
  const instanceId = useId()
  const listboxId = `cmd-results-${instanceId}`
  const defaultCategory = categories[0]?.id ?? 'all'
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(defaultCategory)
  const [selected, setSelected] = useState(0)
  const [drilledId, setDrilledId] = useState<string | null>(null)
  const [drilledFallback, setDrilledFallback] = useState<CommandPaletteItem | null>(null)
  const [previewItem, setPreviewItem] = useState<CommandPaletteItem | null>(null)
  const [resultsHeight, setResultsHeight] = useState<number | null>(null)
  const [heightReady, setHeightReady] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const selectedItemRef = useRef<HTMLDivElement>(null)
  const resultsInnerRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const prevOpenRef = useRef(false)

  const drilledItem = useMemo(
    () => (drilledId ? items.find((item) => item.id === drilledId) ?? drilledFallback : null),
    [drilledId, items, drilledFallback]
  )
  const drilled = drilledItem?.drilldown ?? null

  const exitDrill = useCallback((): void => {
    setDrilledId(null)
    setDrilledFallback(null)
    setQuery('')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }, [])

  const enterDrill = useCallback((item: CommandPaletteItem): void => {
    if (!item.drilldown) return
    setDrilledId(item.id)
    setDrilledFallback(item)
    setQuery('')
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }, [])

  // 注册在 Modal 之上的 LIFO Esc 层：钻取态首按 Esc 退回上一级，次按 Esc 关闭整窗。
  useEscLayer(open && Boolean(drilled), {
    kind: 'modal',
    id: `cmd-drill-${instanceId}`,
    onClose: exitDrill
  })

  // 仅在关闭 → 打开瞬间重置查询与钻取态，关闭退场 115ms 期间保留画面防闪空。
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current
    prevOpenRef.current = open
    composingRef.current = false
    if (!justOpened) return
    setQuery('')
    setCategory(defaultCategory)
    setSelected(0)
    setDrilledId(null)
    setDrilledFallback(null)
    setPreviewItem(null)
    setResultsHeight(null)
    setHeightReady(false)
    const raf = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [open, defaultCategory])

  // 若当前分类被上游数据变更移除，自动回退默认分类。
  useEffect(() => {
    if (!categories.some((entry) => entry.id === category)) {
      setCategory(defaultCategory)
    }
  }, [categories, category, defaultCategory])

  const tokens = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])

  const categoryTabs = useMemo(() => {
    if (categories.length <= 1) return []
    const searching = tokens.length > 0
    return categories.map((entry) => {
      if (!searching) return { id: entry.id, label: entry.label }
      const count = entry.id === 'all'
        ? items.filter((item) => matchTokens(item, tokens)).length
        : items.filter((item) => item.category === entry.id && matchTokens(item, tokens)).length
      return { id: entry.id, label: entry.label, count }
    })
  }, [categories, items, tokens])

  const filtered = useMemo<CommandPaletteItem[]>(() => {
    const pool = drilled
      ? drilled.actions
      : category === 'all'
        ? items
        : items.filter((item) => item.category === category)
    if (tokens.length === 0) return pool.slice(0, maxVisible)
    return pool.filter((item) => matchTokens(item, tokens)).slice(0, maxVisible)
  }, [drilled, category, items, tokens, maxVisible])

  const activeIndex = filtered.length > 0 ? Math.min(selected, filtered.length - 1) : -1
  const activeItem = activeIndex >= 0 ? filtered[activeIndex] : null

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex !== selected) setSelected(activeIndex)
  }, [activeIndex, selected])

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filtered, open])

  // 70ms 防抖同步右侧预览卡（首次打开立即填充，减少长按方向键时的闪烁；退场期间保持画面）。
  useEffect(() => {
    if (!open) return
    const next = activeItem ?? (drilledItem ?? null)
    if (!next) {
      setPreviewItem(null)
      return
    }
    if (!previewItem || prefersReducedMotion()) {
      setPreviewItem(next)
      return
    }
    if (previewItem.id === next.id) {
      setPreviewItem(next)
      return
    }
    const timer = window.setTimeout(() => setPreviewItem(next), PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, activeItem, drilledItem])

  // ResizeObserver 驱动结果容器平滑高度过渡（减少动态效果模式下直接跳过）。
  useLayoutEffect(() => {
    if (!open || prefersReducedMotion()) {
      setResultsHeight(null)
      setHeightReady(false)
      return
    }
    const inner = resultsInnerRef.current
    if (!inner) return
    let readyRaf: number | null = null
    const sync = (): void => {
      const maxPx = Math.min(Math.floor(window.innerHeight * 0.46), MAX_RESULTS_PX)
      const measured = Math.ceil(inner.getBoundingClientRect().height)
      const clamped = Math.max(48, Math.min(measured, maxPx))
      setResultsHeight((prev) => (prev === clamped ? prev : clamped))
      if (!heightReady && readyRaf === null) {
        readyRaf = requestAnimationFrame(() => {
          readyRaf = null
          setHeightReady(true)
        })
      }
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(inner)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      if (readyRaf !== null) cancelAnimationFrame(readyRaf)
    }
  }, [open, filtered.length, drilledId])

  const hasAnyPreview = useMemo(
    () => items.some((item) => Boolean(item.preview)) || Boolean(drilledItem?.preview),
    [items, drilledItem]
  )
  const resolvedPreview = previewItem?.preview ?? (drilled ? drilledItem?.preview : undefined)

  let lastSection = ''

  return (
    <Modal open={open} onClose={onClose} bare placement="top" ariaLabel={ariaLabel}>
      <div className="my-command-stage" data-has-preview={hasAnyPreview ? 'true' : 'false'}>
        <div className="my-command-panel">
          <div className="my-command-header">
            <div className="my-command-search">
              <Search size={15} className="shrink-0 text-my-icon-tertiary" aria-hidden="true" />
              {drilled && (
                <span className="my-command-scope-chip" data-command-scope="true">
                  {drilled.icon && <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{drilled.icon}</span>}
                  <span className="truncate">{drilled.label}</span>
                  <button
                    type="button"
                    aria-label="退出范围筛选"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={exitDrill}
                    className="my-command-scope-chip-close"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              )}
              <input
                ref={inputRef}
                value={query}
                onCompositionStart={() => { composingRef.current = true }}
                onCompositionEnd={() => { composingRef.current = false }}
                onKeyDown={(e) => {
                  if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
                    e.stopPropagation()
                    return
                  }
                  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    if (filtered.length === 0) return
                    setSelected((prev) => (prev + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
                  } else if (e.key === 'Enter' && activeItem) {
                    e.preventDefault()
                    activeItem.run()
                  } else if (e.key === 'Tab' && !e.shiftKey && !drilled && activeItem?.drilldown) {
                    e.preventDefault()
                    e.stopPropagation()
                    enterDrill(activeItem)
                  } else if (e.key === 'Backspace' && !query && drilled) {
                    e.preventDefault()
                    exitDrill()
                  }
                }}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSelected(0)
                }}
                placeholder={drilled ? (drilled.placeholder ?? `在「${drilled.label}」中筛选操作…`) : placeholder}
                aria-label={ariaLabel}
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
                aria-autocomplete="list"
                className="my-focus-none min-w-0 flex-1 bg-transparent text-my-md font-normal text-my-primary outline-none placeholder:text-my-placeholder"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空输入"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery('')
                    setSelected(0)
                    inputRef.current?.focus({ preventScroll: true })
                  }}
                  className="my-command-scope-chip-close"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (drilled ? exitDrill() : onClose())}
                aria-label={drilled ? '返回上一级' : '关闭命令面板'}
                className="my-kbd shrink-0 cursor-pointer"
              >
                Esc
              </button>
            </div>
          </div>

          {!drilled && categoryTabs.length > 1 && (
            <div className="my-command-tabs-bar">
              <Tabs
                tabs={categoryTabs}
                active={category}
                ariaLabel="命令分类"
                onChange={(next) => {
                  setCategory(next)
                  setSelected(0)
                  requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
                }}
              />
            </div>
          )}

          <div
            className="my-command-results-wrap"
            data-ready={heightReady ? 'true' : undefined}
            style={resultsHeight !== null ? { height: resultsHeight } : undefined}
          >
            <div id={listboxId} role="listbox" aria-label="搜索结果" className="my-scrollbar my-fade-scroll my-command-results">
              <div ref={resultsInnerRef} className="my-command-results-inner">
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                    <Command size={16} className="text-my-icon-tertiary" aria-hidden="true" />
                    <div className="text-my-sm text-my-secondary">
                      {query.trim() ? `没有找到与「${query.trim()}」匹配的结果` : '当前分类暂无条目'}
                    </div>
                    <div className="text-my-xs text-my-tertiary">{emptyHint}</div>
                  </div>
                ) : (
                  filtered.map((item, index) => {
                    const header = item.section !== lastSection ? item.section : null
                    lastSection = item.section
                    const isSelected = activeIndex === index
                    const descMatch = isDescriptionOnlyMatch(item, query)
                    return (
                      <div key={item.id} className="flex flex-col gap-0.5">
                        {header && <div className="my-menu-header">{header}</div>}
                        <div
                          id={`${listboxId}-opt-${index}`}
                          role="option"
                          aria-selected={isSelected}
                          ref={isSelected ? selectedItemRef : undefined}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setSelected(index)}
                          onClick={item.run}
                          className="my-command-row"
                        >
                          <span className="my-command-row-icon">{item.icon}</span>
                          <span className="min-w-0 flex-1 truncate">
                            <span className="truncate">{item.label}</span>
                            {item.subtitle && (
                              <span className="ml-2 text-my-xs text-my-tertiary">{item.subtitle}</span>
                            )}
                          </span>
                          {descMatch && (
                            <span className="my-chip shrink-0 bg-my-layer-3 text-my-secondary">描述命中</span>
                          )}
                          {item.badge && !isSelected && <span className="shrink-0">{item.badge}</span>}
                          {!isSelected && item.hint && (
                            <span className="my-item-description max-w-32 shrink-0 truncate">{item.hint}</span>
                          )}
                          {isSelected && (
                            <span className="my-command-row-action">
                              {!drilled && item.drilldown && (
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    enterDrill(item)
                                  }}
                                  className="my-command-drill-trigger"
                                >
                                  <span>操作</span>
                                  <span className="my-command-drill-key">Tab</span>
                                </button>
                              )}
                              <span className="my-command-verb">
                                {item.actionVerb ?? '打开'}
                                <CornerDownLeft size={11} aria-hidden="true" />
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>

          <footer className="my-command-footer">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <kbd className="my-kbd">↑↓</kbd>
                <span>切换</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="my-kbd">↵</kbd>
                <span>{activeItem?.actionVerb ?? '执行'}</span>
              </span>
              {!drilled && activeItem?.drilldown && (
                <span className="inline-flex items-center gap-1">
                  <kbd className="my-kbd">Tab</kbd>
                  <span>更多操作</span>
                </span>
              )}
              {drilled && (
                <span className="inline-flex items-center gap-1">
                  <kbd className="my-kbd">Backspace</kbd>
                  <span>返回上级</span>
                </span>
              )}
            </div>
            <span className="shrink-0 tabular-nums">
              {drilled ? 'Esc 返回' : `${filtered.length} 项`}
            </span>
          </footer>
        </div>

        {hasAnyPreview && resolvedPreview && (
          <aside className="my-command-preview" aria-label="当前选中项预览">
            <div key={previewItem?.id ?? 'preview'} className="my-command-preview-body flex min-h-0 flex-col">
              <div className="flex items-center justify-between gap-2 text-my-2xs text-my-tertiary">
                <span className="truncate">{resolvedPreview.eyebrow}</span>
                {resolvedPreview.code && (
                  <span className="shrink-0 font-mono text-my-2xs text-my-secondary">{resolvedPreview.code}</span>
                )}
              </div>
              <div className="mt-2.5 flex items-start gap-2.5">
                {resolvedPreview.icon && (
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-my-base bg-my-layer-2 text-my-icon-secondary">
                    {resolvedPreview.icon}
                  </span>
                )}
                <div className="my-text-balance min-w-0 flex-1 text-my-sm font-medium leading-my-ui text-my-primary line-clamp-2">
                  {resolvedPreview.title}
                </div>
              </div>
              {resolvedPreview.summary && (
                <p className="mt-2 text-my-xs leading-my-ui text-my-secondary line-clamp-3">
                  {resolvedPreview.summary}
                </p>
              )}
              {resolvedPreview.meta && resolvedPreview.meta.length > 0 && (
                <dl className="my-command-preview-meta">
                  {resolvedPreview.meta.map((entry) => (
                    <div key={entry.label} className="my-command-preview-row">
                      <dt className="shrink-0 text-my-tertiary">{entry.label}</dt>
                      <dd className="flex min-w-0 items-center justify-end gap-1.5 truncate text-my-primary">
                        {entry.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {(drilled || resolvedPreview.footerHint) && (
                <div className="my-command-preview-footer">
                  {drilled ? '回车执行选中操作 · Backspace / Esc 返回上级' : resolvedPreview.footerHint}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </Modal>
  )
}
