import { useEffect, useMemo, useState, type JSX, type RefObject } from 'react'
import { ChevronDown, LoaderCircle, RotateCw } from 'lucide-react'
import { Button, Dropdown, DropdownHeader, DropdownItem, SearchInput } from '../my/ui'
import type { ComposerModel } from './useComposerSend'
import { isSameComposerModel, turnOptionsForModel, type ConversationModelCatalog, type ConversationModelOption } from './useConversationModelCatalog'
import '../model-selection/model-selection-panel.css'

const instanceNames: Readonly<Record<string, string>> = {
  codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', pi: 'Pi', acp: 'ACP',
}

interface ModelPickerProps {
  readonly catalog: ConversationModelCatalog
  readonly value: ComposerModel | null
  readonly onChange: (model: ComposerModel) => void
  readonly anchor: RefObject<HTMLElement>
  readonly triggerRef?: RefObject<HTMLButtonElement>
  readonly lockedInstanceId?: string
  readonly disabled?: boolean
}

function rankModelPickerSearch(items: readonly ConversationModelOption[], query: string): readonly ConversationModelOption[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items
  const tokens = normalized.split(/\s+/u)
  return items.flatMap((item, order) => {
    const name = item.displayName.toLowerCase()
    const fields = [name, item.id, item.group, item.providerId, item.instanceId, item.driverKind]
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

function ModelPickerContent({ catalog, value, onChange, lockedInstanceId, close }: ModelPickerProps & { close: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string>()
  const { ensure, status, error, refresh } = catalog
  const instances = catalog.instances.filter(instance => !lockedInstanceId || instance.instanceId === lockedInstanceId)
  const requestedInstanceId = filter ?? value?.instanceId ?? instances[0]?.instanceId
  const instance = instances.find(item => item.instanceId === requestedInstanceId) ?? instances[0]
  const instanceId = instance?.instanceId
  useEffect(() => {
    if (instanceId) void ensure(instanceId)
  }, [ensure, instanceId])

  const models = useMemo(() => rankModelPickerSearch(
    catalog.models.filter(model => model.instanceId === instanceId),
    query,
  ), [catalog.models, instanceId, query])
  const read = instance?.read
  const turnOptions = value && value.instanceId === instanceId && read?.status === 'ready'
    ? turnOptionsForModel(read.descriptor, value) : []
  const reason = read?.status === 'failed' ? read.error : read?.status === 'ready' &&
    read.descriptor.actions.chat.state === 'unsupported' ? read.descriptor.actions.chat.detail : undefined
  const loading = status === 'loading' || status === 'idle' || Boolean(instance && (!read || read.status === 'loading'))

  return <div className="acp-unified-picker-panel min-h-0 shrink"
    style={{ height: 'auto', maxHeight: 'min(386px, 60vh)' }}>
    <div className="acp-unified-picker-header">
      <SearchInput value={query} onChange={setQuery} size="sm" placeholder="搜索模型" autoFocus />
    </div>
    <div className="acp-unified-picker-body">
      <div className="acp-unified-picker-content my-scrollbar">
        {instances.length > 1 && <div className="flex flex-wrap gap-1 px-1 py-1" aria-label="模型实例">
          {instances.map(item => <button type="button" key={item.instanceId}
            className="my-composer-control px-2 py-1 text-my-xs"
            aria-pressed={instanceId === item.instanceId} data-state={instanceId === item.instanceId ? 'open' : undefined}
            onClick={() => setFilter(item.instanceId)}>
            {instanceNames[item.instanceId] ?? item.instanceId}
          </button>)}
        </div>}
        <DropdownHeader>{instance ? instanceNames[instance.instanceId] ?? instance.instanceId : '选择模型'}</DropdownHeader>
        {loading ? <p className="my-activity-note px-2 py-2" role="status">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />正在读取模型…
        </p> : error || reason ? <p className="px-2 py-2 text-my-sm text-my-secondary break-words" role="status">{error ?? reason}</p>
          : models.length === 0 ? <p className="px-2 py-2 text-my-sm text-my-secondary" role="status">
            {query.trim() ? '未找到匹配的模型' : '这个实例暂无可用模型'}
          </p> : models.map(model => {
            const selected = isSameComposerModel(value, model)
            return <div key={model.id}>
              <DropdownItem selected={selected} onClick={() => {
                if (!selected) onChange(model)
                close()
              }}>
                <span className="min-w-0 truncate" title={model.id}>{model.displayName}</span>
              </DropdownItem>
              {selected && value && turnOptions.map(option => {
                const chosen = value.options?.find(item => item.id === option.id)?.value
                const update = (choice?: string): void => {
                  const previous = value.options?.filter(item => item.id !== option.id) ?? []
                  const options = choice === undefined ? previous : [...previous, { id: option.id, value: choice }]
                  onChange({ ...value, options: options.length ? options : undefined })
                }
                return <div key={option.id} className="acp-unified-tuning-panel">
                  <span className="acp-unified-tuning-header">{option.label}</span>
                  <div className="acp-unified-tuning-options" aria-label={option.label} role="group">
                    <button type="button" aria-pressed={chosen === undefined} onClick={() => update()}>默认</button>
                    {option.choices.map(choice => <button type="button" key={choice.value} aria-pressed={chosen === choice.value}
                      onClick={() => update(choice.value)}>{choice.label}</button>)}
                  </div>
                </div>
              })}
            </div>
          })}
      </div>
    </div>
    <div className="acp-unified-picker-footer">
      <Button type="button" size="sm" variant="ghost" disabled={loading}
        onClick={() => { void refresh(); if (instanceId) void ensure(instanceId, true) }}>
        <RotateCw size={13} aria-hidden="true" />重新读取
      </Button>
    </div>
  </div>
}

export function ConversationModelPicker(props: ModelPickerProps): JSX.Element {
  const { catalog, anchor, value, disabled, triggerRef } = props
  return <Dropdown disabled={disabled} align="right" placement="top" gap={8} width={340} positionAnchorRef={anchor} className="min-w-0"
    trigger={({ open, toggle }) => <button ref={triggerRef} type="button" disabled={disabled}
      aria-label={value ? `选择模型，当前 ${value.displayName}` : '选择模型'}
      aria-expanded={open} className="my-composer-control acp-model-trigger inline-flex items-center gap-1.5 px-1.5 py-1"
      onClick={() => {
        if (!open && catalog.status !== 'loading') void catalog.refresh()
        toggle()
      }}>
      <span className="min-w-0 truncate">{value?.displayName ?? '选择模型'}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>}>
    {(close) => <ModelPickerContent {...props} close={close} />}
  </Dropdown>
}
