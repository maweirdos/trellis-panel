import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Layers } from 'lucide-react'
import { hasIpc } from '../api'
import { Button, Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../my/ui'
import { useHifox } from './store'

/** A team space is available before a local repository is selected. */
export function TeamContextSwitcher({ variant = 'default', selectOpensTasks = true, onManageSpaces }: {
  variant?: 'default' | 'global'
  selectOpensTasks?: boolean
  onManageSpaces?: () => void
} = {}): JSX.Element {
  const { snapshot, currentSpaceId, workspaceContext, loadError, bootstrap, setCurrentSpace, setModule } = useHifox()
  const [reading, setReading] = useState(false)
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const global = variant === 'global'
  const current = snapshot?.spaces.find((space) => space.id === currentSpaceId)
  const actor = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot?.members.find((member) => member.role === 'owner')?.id : undefined)
  const joined = global && workspaceContext.state === 'access-revoked' ? [] : snapshot?.spaces.filter((space) => !space.archived && actor && space.memberIds.includes(actor)) ?? []
  const name = global ? joined.find((space) => space.id === currentSpaceId)?.name ?? '团队空间' : current?.name ?? workspaceContext.projectName ?? '团队空间'
  const status = workspaceContext.state === 'offline' ? '离线缓存 · 权限为上次核对' : workspaceContext.state === 'access-revoked' ? '访问权限已失效' : ''
  const refreshOnOpen = (): void => {
    if (!global || !hasIpc) return
    const ticket = ++request.current
    setReading(true)
    void bootstrap().finally(() => { if (ticket === request.current) setReading(false) })
  }
  return <div className={global ? 'no-drag my-header-team' : 'no-drag flex min-w-0 items-center gap-2'}>
    <Dropdown width={260} className={global ? 'my-header-team-menu' : undefined} placement={global ? 'bottom' : 'auto'} trigger={({ toggle, open }) => {
      const button = <Button variant="ghost" className={global ? 'my-header-team-trigger' : 'my-project-switcher min-w-0'} onClick={() => { if (!open) refreshOnOpen(); toggle() }} aria-expanded={open} aria-label={`切换团队空间${global ? `，当前${name}${status ? ` · ${status}` : ''}` : ''}`}><Layers size={17} aria-hidden="true" /><span className={global ? 'my-header-team-name my-item-title' : 'my-project-switcher-name max-w-64 truncate'}>{name}</span><ChevronDown size={13} aria-hidden="true" /></Button>
      return global ? <Tooltip side="bottom" label={`${name}${status ? ` · ${status}` : ''}`} wrap>{button}</Tooltip> : button
    }}>
      {(close) => <><DropdownHeader>{global ? '团队空间' : workspaceContext.projectName ?? '团队协作'}</DropdownHeader>
        {global && <>
          {reading && <p role="status" className="my-item-description px-3 py-2">正在读取团队空间…</p>}
          {!hasIpc && <p className="my-item-description px-3 py-2">桌面端可查看团队空间</p>}
          {hasIpc && status && <p role="status" className="my-item-description px-3 py-2">{status}</p>}
          {hasIpc && loadError && <p role="alert" className="px-3 py-2 text-my-xs text-my-danger-text">{loadError}</p>}
          {hasIpc && !reading && !loadError && !status && (!snapshot ? <p className="my-item-description px-3 py-2">团队空间尚未取得</p> : !actor ? <p className="my-item-description px-3 py-2">成员身份待核对</p> : joined.length === 0 ? <p className="my-item-description px-3 py-2">暂无已加入的团队空间</p> : null)}
        </>}
        {joined.map((space) => <DropdownItem key={space.id} selected={space.id === currentSpaceId} disabled={global && reading} onClick={() => {
          if (global) {
            const latest = useHifox.getState()
            if (latest.workspaceContext.key !== workspaceContext.key || latest.workspaceContext.actorId !== workspaceContext.actorId || latest.workspaceContext.state === 'access-revoked' || !latest.snapshot?.spaces.some((item) => item.id === space.id && !item.archived && item.memberIds.includes(actor ?? ''))) return
          }
          if (selectOpensTasks) { setCurrentSpace(space.id); setModule('tasks') }
          // The global entry changes selection without resetting the source's filters or task.
          else useHifox.setState({ currentSpaceId: space.id })
          close()
        }}>{space.name}</DropdownItem>)}
        <DropdownItem onClick={() => { setModule('spaces'); onManageSpaces?.(); close() }}>管理空间</DropdownItem>
      </>}
    </Dropdown>
  </div>
}
