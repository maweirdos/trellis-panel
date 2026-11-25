import { useRef, type JSX } from 'react'
import { FolderKanban, Link2, Paperclip, Plus } from 'lucide-react'
import { Dropdown, DropdownDivider, DropdownHeader, DropdownItem } from '../my/ui'

export interface ComposerTaskSection {
  readonly label: string
  readonly description?: string
  readonly disabledReason?: string
  readonly onView?: () => void
  readonly actions?: readonly {
    readonly label: string
    readonly icon: 'link' | 'create'
    readonly onSelect: () => void
    readonly description?: string
    readonly disabledReason?: string
  }[]
}

export interface ComposerAddMenuProps {
  readonly interactive: boolean
  readonly attachment: { readonly available: boolean; readonly disabledReason?: string; readonly pick: () => void }
  readonly taskSection?: ComposerTaskSection
}

export function ComposerAddMenu({ interactive, attachment, taskSection }: ComposerAddMenuProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const choose = (close: () => void, action: () => void): void => {
    triggerRef.current?.focus({ preventScroll: true })
    close()
    action()
  }
  return <div className="conversation-add-anchor">
    <Dropdown placement="top" align="left" width={288}
      trigger={({ open, toggle }) => <button ref={triggerRef} type="button" className="my-icon-control conversation-add-trigger"
        title="添加内容或关联任务" aria-label="添加内容或关联任务" aria-expanded={open} onClick={toggle}>
        <Plus size={16} aria-hidden="true" />
      </button>}>
      {close => <>
        <DropdownHeader>添加到这条消息</DropdownHeader>
        <DropdownItem icon={<Paperclip size={14} aria-hidden="true" />}
          disabled={!interactive || !attachment.available} description={attachment.disabledReason}
          onClick={() => choose(close, attachment.pick)}>添加文件或图片</DropdownItem>
        {taskSection && <>
          <DropdownDivider />
          <DropdownHeader>当前会话</DropdownHeader>
          {taskSection.onView && <DropdownItem icon={<FolderKanban size={14} aria-hidden="true" />}
            description={taskSection.disabledReason ?? taskSection.description}
            disabled={Boolean(taskSection.disabledReason)}
            onClick={() => choose(close, () => taskSection.onView?.())}>
            {taskSection.label}
          </DropdownItem>}
          {taskSection.actions?.map(action => <DropdownItem key={action.label}
            icon={action.icon === 'link' ? <Link2 size={14} aria-hidden="true" /> : <FolderKanban size={14} aria-hidden="true" />}
            description={action.disabledReason ?? taskSection.disabledReason ?? action.description ?? taskSection.description}
            disabled={Boolean(action.disabledReason) || Boolean(taskSection.disabledReason)}
            onClick={() => choose(close, action.onSelect)}>
            {action.label}
          </DropdownItem>)}
        </>}
      </>}
    </Dropdown>
  </div>
}
