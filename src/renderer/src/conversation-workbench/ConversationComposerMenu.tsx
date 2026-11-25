import { Autocomplete } from '@base-ui/react/autocomplete'
import { Tooltip } from '@base-ui/react/tooltip'
import { Blocks, FileText, Folder, MessagesSquare, Package, Paperclip, Settings, UserRound, type LucideIcon } from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ConversationDriverSkillSource } from '../../../shared/conversation/driverCatalog'
import { ComposerCommandMenuLayer } from './ComposerCommandMenuLayer'
import type { ComposerMenuItem, ComposerTrigger } from './useComposerMenuItems'
import './conversation-composer-menu.css'

type TriggerKind = ComposerTrigger['kind']

interface ComposerMenuProps {
  readonly id: string
  readonly anchor: RefObject<HTMLElement | null>
  readonly items: readonly ComposerMenuItem[]
  readonly activeIndex: number
  readonly triggerKind?: TriggerKind
  readonly isLoading?: boolean
  readonly emptyStateText?: string
  readonly onHighlight: (index: number) => void
  readonly onSelect: (item: ComposerMenuItem) => void
}

const LISTBOX_LABEL_BY_TRIGGER: Record<TriggerKind, string> = {
  path: '来源',
  'slash-command': '命令',
  skill: '技能',
}

const EMPTY_STATE_BY_TRIGGER: Record<TriggerKind, string> = {
  path: '没有匹配的来源。',
  'slash-command': '没有匹配的命令。',
  skill: '没有找到技能。输入 / 可浏览可用命令。',
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`
}

export const ConversationComposerMenu = memo(function ConversationComposerMenu({
  id, anchor, items, activeIndex, triggerKind, isLoading, emptyStateText, onHighlight, onSelect,
}: ComposerMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeItemId = items[activeIndex]?.id

  useLayoutEffect(() => {
    if (!activeItemId) return
    const option = listRef.current?.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(activeItemId)}"]`,
    )
    option?.scrollIntoView({ block: 'nearest' })
  }, [activeItemId])

  return (
    <ComposerCommandMenuLayer anchor={anchor.current}>
      <Autocomplete.Root
        inline
        open
        keepHighlight
        autoHighlight={false}
        mode="none"
        onItemHighlighted={(value) => {
          const index = items.findIndex(item => item.id === value)
          if (index >= 0 && index !== activeIndex) onHighlight(index)
        }}
      >
        <div ref={listRef} data-composer-banner-surface="attached" data-composer-command-drawer="true">
          {items.length > 0 ? (
            <Autocomplete.List data-slot="command-list" id={id}
              aria-label={triggerKind ? LISTBOX_LABEL_BY_TRIGGER[triggerKind] : '输入建议'}
              className="my-scrollbar">
              <Autocomplete.Group data-slot="command-group">
                {items.map((item, index) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    optionId={composerSuggestionOptionId(id, item.id)}
                    item={item}
                    triggerKind={triggerKind}
                    isActive={index === activeIndex}
                    onHighlight={() => onHighlight(index)}
                    onSelect={onSelect}
                  />
                ))}
              </Autocomplete.Group>
            </Autocomplete.List>
          ) : (
            <div className="conversation-command-empty" role="status">
              {isLoading ? (triggerKind === 'path' ? '正在查找工程文件…' : '正在查找技能…')
                : emptyStateText ?? EMPTY_STATE_BY_TRIGGER[triggerKind ?? 'slash-command']}
            </div>
          )}
        </div>
      </Autocomplete.Root>
    </ComposerCommandMenuLayer>
  )
})

function ComposerCommandMenuItem({ optionId, item, triggerKind, isActive, onHighlight, onSelect }: {
  readonly optionId: string
  readonly item: ComposerMenuItem
  readonly triggerKind?: TriggerKind
  readonly isActive: boolean
  readonly onHighlight: () => void
  readonly onSelect: (item: ComposerMenuItem) => void
}) {
  const Icon = item.type === 'thread' ? MessagesSquare : item.type === 'attachment' ? Paperclip
    : item.type === 'file' ? (item.kind === 'directory' ? Folder : FileText) : null
  const skillSource = item.type === 'skill' ? item.source : undefined
  return (
    <Autocomplete.Item
      render={<div id={optionId} />}
      value={item.id}
      data-slot="command-item"
      data-composer-item-id={item.id}
      data-active={isActive || undefined}
      aria-selected={isActive}
      onMouseMove={() => { if (!isActive) onHighlight() }}
      onMouseDown={event => event.preventDefault()}
      onClick={() => onSelect(item)}
    >
      {Icon && <Icon aria-hidden="true" />}
      <span className="conversation-command-item-copy">
        <span className="conversation-command-label" title={item.label}>
          {item.type === 'skill' && item.label.startsWith('/skill:')
            ? <><span>/skill:</span>{item.label.slice('/skill:'.length)}</>
            : item.label}
        </span>
        <ComposerCommandDescription text={item.description} active={isActive} />
        {skillSource && <SkillSourceBadge source={skillSource} showSkillSuffix={triggerKind === 'skill'} />}
      </span>
    </Autocomplete.Item>
  )
}

function ComposerCommandDescription({ text, active }: { readonly text?: string; readonly active: boolean }) {
  const descriptionRef = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const description = descriptionRef.current
    if (!active || !description) {
      setTruncated(false)
      return
    }
    const measure = () => setTruncated(description.scrollWidth > description.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(description)
    return () => observer.disconnect()
  }, [active, text])
  const portalRoot = descriptionRef.current?.closest<HTMLElement>('.my-root')
  return (
    <Tooltip.Root open={active && truncated && Boolean(portalRoot)}>
      <Tooltip.Trigger tabIndex={-1} render={<span ref={descriptionRef} className="conversation-command-description" />}>
        {text}
      </Tooltip.Trigger>
      {portalRoot && <Tooltip.Portal container={portalRoot}>
        <Tooltip.Positioner side="top" sideOffset={4} className="conversation-command-tooltip-positioner">
          <Tooltip.Popup className="my-tooltip conversation-command-tooltip">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>}
    </Tooltip.Root>
  )
}

const SKILL_SOURCE_LABELS: Record<ConversationDriverSkillSource, { icon: LucideIcon; label: string }> = {
  app: { icon: Blocks, label: '应用' },
  repo: { icon: Folder, label: '仓库' },
  personal: { icon: UserRound, label: '个人' },
  system: { icon: Settings, label: '系统' },
  other: { icon: Package, label: '引擎' },
}

function SkillSourceBadge({ source, showSkillSuffix }: {
  readonly source: ConversationDriverSkillSource
  readonly showSkillSuffix: boolean
}) {
  const { icon: Icon, label } = SKILL_SOURCE_LABELS[source]
  return <span className="my-chip conversation-command-skill-source">
    <Icon size={12} aria-hidden="true" />
    {showSkillSuffix ? `${label}技能` : label}
  </span>
}
