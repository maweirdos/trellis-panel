import { useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Bot, Code2, Info, Link2, MessageSquare, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { useEscLayer } from '../../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../../utils/interaction-scope'
import '../task-conversation-entry.css'

export interface TaskConversationEntryProps {
  title: string
  sourceLabel: string
  source: 'codex' | 'claude-code' | 'zcode' | 'panel' | 'unbound'
  capability: 'session' | 'workspace' | 'associate' | 'unavailable'
  onOpen: () => void
  disabled?: boolean
  pending?: boolean
  onManage?: () => void
  destinationLabel?: string
  unavailableReason?: string
}

// Semantic library icons: vendor identity remains in the supplied source label.
export const TASK_CONVERSATION_SOURCE_ICONS: Record<TaskConversationEntryProps['source'], LucideIcon> = {
  codex: Bot,
  'claude-code': Sparkles,
  zcode: Code2,
  panel: MessageSquare,
  unbound: Link2
}

const DESTINATIONS: Record<TaskConversationEntryProps['capability'], string> = {
  session: '打开会话',
  workspace: '打开工作区',
  associate: '关联会话',
  unavailable: '入口不可用'
}

/** Render as a sibling of the task action, inside the App-owned .my-root. */
export function TaskConversationEntry({
  title,
  sourceLabel,
  source,
  capability,
  onOpen,
  disabled = false,
  pending = false,
  onManage,
  destinationLabel,
  unavailableReason
}: TaskConversationEntryProps): JSX.Element {
  const tooltipId = useId()
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const focused = useRef(false)
  const [open, setOpen] = useState(false)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  // aria-disabled preserves keyboard access to the unavailable destination's explanation.
  const blocked = disabled || pending || capability === 'unavailable'
  const destination = destinationLabel || DESTINATIONS[capability]
  const status = pending ? '处理中…' : capability === 'unavailable' && destinationLabel ? '入口不可用' : disabled && capability !== 'unavailable' ? '暂不可用' : ''
  const description = [sourceLabel, destination, status, unavailableReason].filter(Boolean).join(' · ')
  const destinationBadge = capability === 'workspace' ? '工作区' : destinationLabel && /终端|terminal|cli/i.test(destinationLabel) ? '终端' : null
  const SourceIcon = TASK_CONVERSATION_SOURCE_ICONS[source]
  const ActionIcon = capability === 'unavailable' ? Info : capability === 'associate' ? Plus : ArrowUpRight
  const visible = open && interactive && portalRoot !== null

  useEscLayer(visible, {
    kind: 'overlay',
    id: `task-conversation-${tooltipId}`,
    onClose: () => setOpen(false)
  })

  useLayoutEffect(() => {
    if (!interactive) {
      hovered.current = false
      focused.current = false
      setOpen(false)
    }
    setPortalRoot(open && interactive ? buttonRef.current?.closest<HTMLElement>('.my-root') ?? null : null)
    if (!open || !interactive) setPosition(null)
  }, [open, interactive])

  useLayoutEffect(() => {
    if (!visible) return
    const button = buttonRef.current
    const tooltip = tooltipRef.current
    if (!button || !tooltip) return

    const updatePosition = (): void => {
      if (!canInteract() || !button.isConnected) return
      const rect = button.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = document.documentElement.clientHeight
      if (rect.bottom <= 0 || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= viewportWidth) {
        setOpen(false)
        return
      }
      const tokens = getComputedStyle(button)
      const gutter = Number.parseFloat(tokens.getPropertyValue('--my-space-8'))
      const gap = Number.parseFloat(tokens.getPropertyValue('--my-space-6'))
      const left = Math.max(gutter, Math.min(rect.left, viewportWidth - tooltip.offsetWidth - gutter))
      const top = Math.max(gutter, Math.min(rect.top - tooltip.offsetHeight - gap, viewportHeight - tooltip.offsetHeight - gutter))
      setPosition((previous) => previous?.left === left && previous.top === top ? previous : { left, top })
    }
    const dismiss = (): void => setOpen(false)
    const observer = new ResizeObserver(updatePosition)
    observer.observe(button)
    observer.observe(tooltip)
    updatePosition()
    window.addEventListener('resize', updatePosition)
    // Native focus may scroll a narrow task list into view after focus fires.
    // Follow that scroll instead of dismissing the keyboard user's new preview.
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('blur', dismiss)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [visible, title, description, canInteract])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="my-task-conversation-entry"
        data-source={source}
        data-capability={capability}
        aria-label={`${title} · ${description}`}
        aria-describedby={visible ? tooltipId : undefined}
        aria-disabled={blocked || !interactive || undefined}
        aria-busy={pending || undefined}
        aria-description={onManage ? '右键或按 Shift+F10 管理关联会话' : undefined}
        onContextMenu={onManage ? (event) => {
          if (!canInteract()) return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          onManage()
        } : undefined}
        onKeyDown={onManage ? (event) => {
          if (!canInteract() || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          onManage()
        } : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch' || !canInteract()) return
          hovered.current = true
          setOpen(true)
        }}
        onPointerLeave={() => {
          hovered.current = false
          if (!focused.current) setOpen(false)
        }}
        onFocus={() => {
          if (!canInteract()) return
          focused.current = true
          setOpen(true)
        }}
        onBlur={() => {
          focused.current = false
          if (!hovered.current) setOpen(false)
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (blocked || !canInteract()) return
          setOpen(false)
          onOpen()
        }}
      >
        <span className="my-task-conversation-entry__icon" aria-hidden="true"><SourceIcon /></span>
        <span className="my-task-conversation-entry__text" aria-hidden="true">
          <span className="my-task-conversation-entry__title">{pending ? '处理中…' : title}</span>
          {destinationBadge && <span className="my-task-conversation-entry__destination">{destinationBadge}</span>}
        </span>
        <span className="my-task-conversation-entry__action" aria-hidden="true"><ActionIcon /></span>
      </button>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="my-task-conversation-tooltip"
          data-positioned={position !== null}
          style={position ?? undefined}
        >
          <div className="my-task-conversation-tooltip__title">{title}</div>
          <div className="my-task-conversation-tooltip__description">{description}{onManage ? ' · 右键管理关联' : ''}</div>
        </div>,
        portalRoot
      )}
    </>
  )
}
