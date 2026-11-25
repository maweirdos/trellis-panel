import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { Check, ChevronDown, LoaderCircle, RotateCw, Star } from 'lucide-react'
import { projectRootKey } from '../my/navigation'
import { Button, Dropdown, SearchInput } from '../my/ui'
import type { ComposerModel } from './useComposerSend'
import { isSameComposerModel, turnOptionsForModel, unavailableModelReason,
  type ConversationModelCatalog, type ConversationModelOption } from './useConversationModelCatalog'
import { modelPickerKey, readModelPickerPreferences, subscribeModelPickerPreferences,
  toggleModelFavorite, recordModelUsed } from './modelPickerPreferences'
import './conversation-model-picker.css'

const instanceNames: Readonly<Record<string, string>> = {
  codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', pi: 'Pi', acp: 'ACP',
}

function instanceLabel(instanceId: string): string {
  return instanceNames[instanceId] ?? instanceId
}

function modelTurnOptions(catalog: ConversationModelCatalog, model: ComposerModel | null) {
  const read = catalog.instances.find(instance => instance.instanceId === model?.instanceId)?.read
  return model && read?.status === 'ready'
    ? turnOptionsForModel(read.descriptor, model).filter(option => option.choices.length > 1)
    : []
}

interface ModelPickerProps {
  readonly catalog: ConversationModelCatalog
  readonly value: ComposerModel | null
  readonly onChange: (model: ComposerModel) => void
  readonly anchor: RefObject<HTMLElement>
  readonly triggerRef?: RefObject<HTMLButtonElement>
  readonly lockedInstanceId?: string
  readonly disabled?: boolean
  /** Favorites and recents are scoped per project root; omitted means no persistence. */
  readonly root?: string
}

const emptyPreferences = { favorites: [], recent: [] } as const
const emptySnapshot = () => emptyPreferences
const favoritesTab = 'favorite-models'

function rankModelPickerSearch(items: readonly ConversationModelOption[], query: string): readonly ConversationModelOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items
  const tokens = normalized.split(/\s+/u)
  return items.flatMap((item, order) => {
    const name = item.displayName.toLowerCase()
    const fields = [name, item.id, item.group, item.providerId, item.instanceId, item.driverKind, instanceLabel(item.instanceId)]
      .filter((value): value is string => Boolean(value))
      .map(value => value.toLowerCase())
    if (name === normalized) return [{ item, order, score: -1000 }]
    let score = 0
    for (const token of tokens) {
      const index = fields.findIndex(field => field.includes(token))
      if (index < 0) return []
      score += index * 10 + (fields[index]?.startsWith(token) ? 0 : 4)
    }
    return [{ item, order, score }]
  }).sort((left, right) => left.score - right.score || left.order - right.order).map(entry => entry.item)
}

/** A provider badge so two same-named models from different instances stay distinguishable. */
function InstanceBadge({ instanceId }: { readonly instanceId: string }): JSX.Element {
  return <span className="conversation-model-instance" aria-label={instanceLabel(instanceId)}>
    {instanceLabel(instanceId).slice(0, 1).toUpperCase()}
  </span>
}

function ModelRow({ model, selected, favorite, reason, showInstance, onPick, onFavorite }: {
  readonly model: ConversationModelOption
  readonly selected: boolean
  readonly favorite: boolean
  readonly reason?: string
  readonly showInstance: boolean
  readonly onPick: () => void
  readonly onFavorite?: () => void
}): JSX.Element {
  return <div className="conversation-model-row" data-selected={selected ? 'true' : undefined}
    data-unavailable={reason ? 'true' : undefined} data-testid="model-row">
    <button type="button" className="conversation-model-pick" aria-pressed={selected} disabled={Boolean(reason)}
      aria-label={`${model.displayName}，${instanceLabel(model.instanceId)}${reason ? `，${reason}` : ''}`}
      title={reason ?? `${model.displayName} · ${instanceLabel(model.instanceId)}`} onClick={onPick}>
      <InstanceBadge instanceId={model.instanceId} />
      <span className="conversation-model-row-name">{model.displayName}</span>
      {showInstance && <span className="conversation-model-group">{instanceLabel(model.instanceId)}</span>}
      {selected && <Check size={14} aria-hidden="true" />}
      {reason && <span className="conversation-model-badge">不可用</span>}
    </button>
    {onFavorite && <button type="button" className="conversation-model-favorite" data-favorite={favorite ? 'true' : undefined}
      aria-label={`${favorite ? '移出收藏' : '加入收藏'}：${model.displayName}，${instanceLabel(model.instanceId)}`}
      aria-pressed={favorite} disabled={Boolean(reason) && !favorite} onClick={onFavorite}>
      <Star size={13} aria-hidden="true" />
    </button>}
  </div>
}

function ModelPickerContent({ catalog, value, onChange, lockedInstanceId, root, close }: ModelPickerProps & { close: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const effortRef = useRef<HTMLDivElement>(null)
  const rootKey = projectRootKey(root)
  const subscribe = useCallback((notify: () => void) => rootKey
    ? subscribeModelPickerPreferences(rootKey, notify) : () => undefined, [rootKey])
  const snapshot = useCallback(() => rootKey ? readModelPickerPreferences(rootKey) : emptyPreferences, [rootKey])
  const preferences = useSyncExternalStore(subscribe, snapshot, emptySnapshot)
  const { ensure, status, error, refresh } = catalog
  const instances = catalog.instances.filter(instance => !lockedInstanceId || instance.instanceId === lockedInstanceId)
  const favoriteSet = new Set(preferences.favorites)
  const eligibleInstance = instances.find(item => item.instanceId === value?.instanceId) ?? instances[0]
  const selectedTab = filter ?? (eligibleInstance ? `instance:${eligibleInstance.instanceId}` : undefined)
  const showingFavorites = selectedTab === favoritesTab
  const instanceId = selectedTab?.startsWith('instance:') ? selectedTab.slice('instance:'.length) : undefined
  const instance = instances.find(item => item.instanceId === instanceId)
  const searching = query.trim().length > 0
  const loadingAll = searching || showingFavorites
  useEffect(() => {
    const recentInstances = new Set(preferences.recent.map(key => key.split('\u0000', 1)[0]))
    for (const item of catalog.instances) {
      if (lockedInstanceId && item.instanceId !== lockedInstanceId) continue
      if (loadingAll || item.instanceId === instanceId || item.instanceId === value?.instanceId ||
        recentInstances.has(item.instanceId)) void ensure(item.instanceId)
    }
  }, [catalog.instances, ensure, instanceId, loadingAll, lockedInstanceId, preferences.recent, value?.instanceId])

  const visible = catalog.models.filter(model => !lockedInstanceId || model.instanceId === lockedInstanceId)
  const visibleByKey = new Map(visible.map(model => [modelPickerKey(model.instanceId, model.id), model]))
  const favorites = preferences.favorites.flatMap(key => visibleByKey.get(key) ?? [])
  const scoped = searching ? visible : showingFavorites ? favorites : visible.filter(model => model.instanceId === instanceId)
  const models = rankModelPickerSearch(scoped, query)
  const read = instance?.read
  const loading = status === 'loading' || status === 'idle' || (loadingAll
    ? instances.some(item => !item.read || item.read.status === 'loading')
    : Boolean(instance && (!read || read.status === 'loading')))
  const turnOptions = modelTurnOptions(catalog, value)
  const reasoning = turnOptions.find(option => option.category === 'reasoning')
  const orderedOptions = reasoning ? [reasoning, ...turnOptions.filter(option => option !== reasoning)] : turnOptions
  const reason = read?.status === 'failed' ? read.error : read?.status === 'ready' &&
    read.descriptor.actions.chat.state === 'unsupported' ? read.descriptor.actions.chat.detail : undefined
  const pick = (model: ComposerModel): void => {
    if (rootKey) recordModelUsed(rootKey, model.instanceId, model.id)
    const changed = !isSameComposerModel(value, model)
    if (changed) onChange(model)
    if (!modelTurnOptions(catalog, model).length) {
      close()
      return
    }
    requestAnimationFrame(focusEffort)
  }
  const focusEffort = (): void => {
    const row = effortRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
    row?.focus()
  }
  const heading = showingFavorites ? '收藏' : instance ? instanceLabel(instance.instanceId) : '模型'
  const recentModels = searching || showingFavorites ? [] : preferences.recent.flatMap(key => visibleByKey.get(key) ?? [])
  const renderModel = (model: ConversationModelOption, recent = false): JSX.Element => {
    const key = modelPickerKey(model.instanceId, model.id)
    return <ModelRow key={recent ? `recent:${key}` : key} model={model} selected={isSameComposerModel(value, model)}
      reason={unavailableModelReason(catalog, model)} favorite={favoriteSet.has(key)}
      showInstance={recent || loadingAll || visible.some(item => item.instanceId !== model.instanceId && item.displayName === model.displayName)}
      onPick={() => pick(model)} onFavorite={rootKey ? () => toggleModelFavorite(rootKey, model.instanceId, model.id) : undefined} />
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.altKey || event.metaKey || !(event.target instanceof HTMLElement)) return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.conversation-model-pick:not(:disabled)') ?? [])]
    const fromSearch = searchRef.current?.contains(event.target)
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (event.key === 'ArrowRight' && !event.shiftKey && turnOptions.length > 0 &&
      (index >= 0 || fromSearch && event.target instanceof HTMLInputElement &&
        event.target.selectionEnd === event.target.value.length)) {
      event.preventDefault()
      if (index >= 0 && event.target.getAttribute('aria-pressed') !== 'true') buttons[index]?.click()
      else focusEffort()
      return
    }
    if (event.key === 'ArrowLeft' && effortRef.current?.contains(event.target)) {
      event.preventDefault()
      searchRef.current?.querySelector('input')?.focus()
      return
    }
    if (event.key === 'Enter' && fromSearch) {
      event.preventDefault()
      buttons[0]?.click()
      return
    }
    if ((!fromSearch && index < 0) || !['ArrowUp', 'ArrowDown'].includes(event.key) || !buttons.length) return
    event.preventDefault()
    const next = fromSearch ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return <div className="conversation-model-picker" onKeyDown={onKeyDown}>
    <div className="conversation-model-columns">
    <aside className="conversation-model-sidebar" aria-label="模型来源">
      {rootKey && instances.length > 0 && <button type="button" className="conversation-model-tab" aria-pressed={showingFavorites}
        aria-label="收藏" title="收藏" onClick={() => setFilter(favoritesTab)}><Star size={18} aria-hidden="true" /></button>}
      {rootKey && instances.length > 0 && <span className="conversation-model-sidebar-divider" aria-hidden="true" />}
      {instances.map(item => <button key={item.instanceId} type="button" className="conversation-model-tab"
        aria-pressed={instanceId === item.instanceId} aria-label={instanceLabel(item.instanceId)} title={instanceLabel(item.instanceId)}
        data-driver={item.driverKind} onClick={() => setFilter(`instance:${item.instanceId}`)}>
        <span className="conversation-model-tab-glyph">{instanceLabel(item.instanceId).slice(0, 1).toUpperCase()}</span>
      </button>)}
    </aside>
    <div className="conversation-model-main">
      <div className="conversation-model-search" ref={searchRef}>
        <SearchInput value={query} onChange={setQuery} size="sm" placeholder="搜索模型" autoFocus />
      </div>
      <div className="conversation-model-list my-scrollbar" role="group" aria-label={heading} ref={listRef}>
        {recentModels.length > 0 && <p className="conversation-model-section">最近使用</p>}
        {recentModels.map(model => renderModel(model, true))}
        {models.length > 0 && recentModels.length > 0 && <p className="conversation-model-section">{heading}</p>}
        {loading && models.length === 0 ? <p className="conversation-model-status" role="status">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />正在读取模型…
        </p> : error || (!loadingAll && reason) ? <p className="conversation-model-status" role="status">{error ?? reason}</p>
          : models.length === 0 ? <p className="conversation-model-status" role="status">
            {searching ? '未找到匹配的模型' : showingFavorites ? '还没有可用的收藏模型。'
              : instance ? '这个实例暂无可用模型' : '暂无已配置的模型实例。'}
          </p> : models.map(model => renderModel(model))}
      </div>
    </div>
    <div className="conversation-model-effort" ref={effortRef}>
      <div className="conversation-model-effort-heading">
        <span>{reasoning?.label ?? (turnOptions.length ? '模型参数' : '推理强度')}</span>
        <span title={value?.displayName}>{value?.displayName}</span>
      </div>
      <div className="conversation-model-effort-list my-scrollbar">
        {value && orderedOptions.map(option => {
          const chosen = value.options?.find(item => item.id === option.id)?.value
          const update = (choice?: string): void => {
            const previous = value.options?.filter(item => item.id !== option.id) ?? []
            const options = choice === undefined ? previous : [...previous, { id: option.id, value: choice }]
            onChange({ ...value, options: options.length ? options : undefined })
            close()
          }
          return <div key={option.id} className="conversation-model-effort-option" role="radiogroup" aria-label={option.label}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 ||
                (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
              const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
              const index = rows.indexOf(event.target as HTMLButtonElement)
              if (index < 0) return
              event.preventDefault()
              rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))]?.focus()
            }}>
            {option !== reasoning && <span className="conversation-model-effort-label">{option.label}</span>}
            {[{ label: '默认', value: undefined }, ...option.choices].map(choice => {
              const selected = chosen === choice.value
              return <button type="button" role="radio" key={choice.value ?? ''} aria-checked={selected}
                tabIndex={selected ? 0 : -1} onClick={() => update(choice.value)}>
                <span>{choice.label}</span>{selected && <Check size={14} aria-hidden="true" />}
              </button>
            })}
          </div>
        })}
        {orderedOptions.length === 0 && <p className="conversation-model-status">暂无可调档位</p>}
      </div>
    </div>
    </div>
    <div className="conversation-model-footer">
        <span className="conversation-model-footer-note">{heading}</span>
        <Button type="button" size="sm" variant="ghost" disabled={loading}
          onClick={() => { void refresh(); if (instanceId) void ensure(instanceId, true) }}>
          <RotateCw size={13} aria-hidden="true" />重新读取
        </Button>
    </div>
  </div>
}

export function ConversationModelPicker(props: ModelPickerProps): JSX.Element {
  const { catalog, anchor, value, disabled, triggerRef } = props
  const reasoning = modelTurnOptions(catalog, value).find(option => option.category === 'reasoning')
  const effort = reasoning?.choices.find(choice => choice.value ===
    (value?.options?.find(option => option.id === reasoning.id)?.value ?? reasoning.current))
  return <Dropdown disabled={disabled} align="right" placement="top" gap={8} width={552} positionAnchorRef={anchor} className="min-w-0"
    trigger={({ open, toggle }) => <button ref={triggerRef} type="button" disabled={disabled}
      aria-label={value ? `选择模型，当前 ${value.displayName}` : '选择模型'}
      aria-expanded={open} className="my-composer-control acp-model-trigger inline-flex items-center gap-1.5 px-1.5 py-1"
      onClick={() => {
        if (!open && catalog.status !== 'loading') void catalog.refresh()
        toggle()
      }}>
      <span className="min-w-0 truncate">{value?.displayName ?? '选择模型'}</span>
      {effort && <span className="conversation-model-trigger-effort">{effort.label}</span>}
      <ChevronDown size={13} aria-hidden="true" />
    </button>}>
    {(close) => <ModelPickerContent {...props} close={close} />}
  </Dropdown>
}
