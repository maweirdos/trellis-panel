import { useId, type JSX, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { CruxAgentAvatarId } from '@shared/crux'
import assistant from '@/assets/avatars/agent/assistant.webp'
import research from '@/assets/avatars/agent/research.webp'
import design from '@/assets/avatars/agent/design.webp'
import engineering from '@/assets/avatars/agent/engineering.webp'
import quality from '@/assets/avatars/agent/quality.webp'
import coordination from '@/assets/avatars/agent/coordination.webp'
import documentation from '@/assets/avatars/agent/documentation.webp'
import data from '@/assets/avatars/agent/data.webp'
import automation from '@/assets/avatars/agent/automation.webp'
import operations from '@/assets/avatars/agent/operations.webp'
import { Dropdown, DropdownItem } from '../my/ui'

const AVATARS = {
  assistant: { description: '薄荷绿软壳', src: assistant },
  research: { description: '蓝色放大镜', src: research },
  design: { description: '淡紫叠片', src: design },
  engineering: { description: '红色积木', src: engineering },
  quality: { description: '黄色三角', src: quality },
  coordination: { description: '珊瑚色分叉', src: coordination },
  documentation: { description: '深蓝书本', src: documentation },
  data: { description: '浅蓝阶梯', src: data },
  automation: { description: '橙色齿轮', src: automation },
  operations: { description: '紫色灯塔', src: operations }
} satisfies Record<CruxAgentAvatarId, { description: string; src: string }>

export function AgentAvatar({ avatarId = 'assistant', size }: { avatarId?: CruxAgentAvatarId; size: number }): JSX.Element {
  return <img src={AVATARS[avatarId].src} alt="" width={size} height={size} draggable={false} className="shrink-0 object-contain" />
}

const AVATAR_IDS = Object.keys(AVATARS) as CruxAgentAvatarId[]
const ARROW_OFFSET: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }

function moveAvatarFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const offset = ARROW_OFFSET[event.key]
  if (offset === undefined || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
  const index = buttons.findIndex(button => button === event.target)
  if (index < 0) return
  event.preventDefault()
  event.stopPropagation()
  const next = buttons[index + offset]
  next?.focus({ preventScroll: true })
  next?.scrollIntoView({ block: 'nearest' })
}

export function AgentAvatarPicker({ id, value = 'assistant', onChange, disabled }: {
  id?: string
  value?: CruxAgentAvatarId
  onChange: (value: CruxAgentAvatarId) => void
  disabled?: boolean
}): JSX.Element {
  const fallbackId = useId()
  const pickerId = id ?? fallbackId
  const optionsId = `${pickerId}-options`
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={pickerId} className="my-item-title shrink-0">头像</label>
      <Dropdown
        disabled={disabled}
        trigger={({ open, toggle }) => (
          <button
            id={pickerId}
            type="button"
            disabled={disabled}
            aria-label={`Agent 头像，当前为${AVATARS[value].description}`}
            aria-expanded={open}
            aria-controls={open ? optionsId : undefined}
            onClick={toggle}
            className="my-select-trigger my-select-trigger-sm"
          >
            <AgentAvatar avatarId={value} size={24} />
            <ChevronDown size={13} className={`my-select-chevron shrink-0 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      >
        {(close) => (
          <div id={optionsId} className="collab-avatar-grid" role="group" aria-label="选择 Agent 头像" onKeyDown={moveAvatarFocus}>
            {AVATAR_IDS.map((avatarId) => (
              <DropdownItem
                key={avatarId}
                selected={avatarId === value}
                icon={<AgentAvatar avatarId={avatarId} size={36} />}
                onClick={() => {
                  close()
                  onChange(avatarId)
                }}
              >
                <span className="sr-only">{AVATARS[avatarId].description}</span>
              </DropdownItem>
            ))}
          </div>
        )}
      </Dropdown>
    </div>
  )
}
