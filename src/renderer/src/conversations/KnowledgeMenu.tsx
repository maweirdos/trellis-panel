import type { JSX } from 'react'
import { BookOpen, FileInput, Settings2 } from 'lucide-react'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { useInteractionGuard } from '../utils/interaction-scope'
import { projectRootKey } from '../my/navigation'

/** Explicit sources remain distinct from the shell's optional engineering project. */
export function ConversationKnowledgeMenu({ onAddFiles, canAddFiles }: { onAddFiles(): void; canAddFiles: boolean }): JSX.Element {
  const snapshot = useApp(state => state.snapshot)
  const canInteract = useInteractionGuard()
  const root = projectRootKey(snapshot?.meta.root)
  return <Dropdown placement="top" width={288} trigger={({ open, toggle }) => <Button variant="ghost" size="sm"
    className="acp-context-action" aria-label="知识与资料" aria-expanded={open} onClick={toggle}><BookOpen size={14} aria-hidden="true" /><span>知识库</span></Button>}>
    {close => <>
      <DropdownHeader>知识与资料</DropdownHeader>
      <DropdownItem icon={<FileInput size={14} />} disabled={!canAddFiles} onClick={() => { close(); if (canInteract()) onAddFiles() }}>选入会话资料</DropdownItem>
      {root && snapshot && <DropdownItem icon={<BookOpen size={14} />} onClick={() => {
        close()
        if (!canInteract() || projectRootKey(useApp.getState().snapshot?.meta.root) !== root) return
        useMy.getState().setKnowledgeView('company')
        useApp.getState().setPage('knowledge')
      }}><span className="block min-w-0"><span className="my-item-title block">查看工程知识库</span><span className="my-item-description block truncate">{snapshot.meta.name}</span></span></DropdownItem>}
      <DropdownItem icon={<Settings2 size={14} />} onClick={() => { close(); if (canInteract()) useApp.getState().setPage('integrations') }}>管理知识连接</DropdownItem>
    </>}
  </Dropdown>
}
