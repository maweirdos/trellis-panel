import { ChevronDown, Layers } from 'lucide-react'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useHifox } from './store'

/** A team space is available before a local repository is selected. */
export function TeamContextSwitcher(): JSX.Element {
  const { snapshot, currentSpaceId, workspaceContext, setCurrentSpace, setModule } = useHifox()
  const current = snapshot?.spaces.find((space) => space.id === currentSpaceId)
  const actor = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot?.members.find((member) => member.role === 'owner')?.id : undefined)
  const joined = snapshot?.spaces.filter((space) => !space.archived && actor && space.memberIds.includes(actor)) ?? []
  return <div className="no-drag flex min-w-0 items-center gap-2">
    <Dropdown width={260} trigger={({ toggle, open }) => <Button variant="ghost" className="my-project-switcher min-w-0" onClick={toggle} aria-expanded={open} aria-label="切换团队空间"><Layers size={17} /><span className="my-project-switcher-name max-w-64 truncate">{current?.name ?? workspaceContext.projectName ?? '团队空间'}</span><ChevronDown size={13} /></Button>}>
      {(close) => <><DropdownHeader>{workspaceContext.projectName ?? '团队协作'}</DropdownHeader>{joined.map((space) => <DropdownItem key={space.id} selected={space.id === currentSpaceId} onClick={() => { setCurrentSpace(space.id); setModule('tasks'); close() }}>{space.name}</DropdownItem>)}<DropdownItem onClick={() => { setModule('spaces'); close() }}>管理空间</DropdownItem></>}
    </Dropdown>
  </div>
}
