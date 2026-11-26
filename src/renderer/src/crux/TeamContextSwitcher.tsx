import { useEffect, useRef, useState } from 'react'
import { Building2, ChevronDown, Layers, Plus, Settings2 } from 'lucide-react'
import { clsx } from 'clsx'
import { hasIpc } from '../api'
import { useApp } from '../store'
import { Button, Dropdown, DropdownDivider, DropdownHeader, DropdownItem, Modal, Tooltip } from '../my/ui'
import { ConnectionPanel } from './ConnectionPanel'
import { SpaceSetupWizard } from './account/SpaceSetupWizard'
import { useCrux } from './store'

/** 顶栏全局组织与空间切换器：聚焦 组织 -> 空间 两层结构。 */
export function TeamContextSwitcher({ variant = 'default', selectOpensTasks = true, onManageSpaces }: {
  variant?: 'default' | 'global'
  selectOpensTasks?: boolean
  onManageSpaces?: () => void
} = {}): JSX.Element {
  const { snapshot, currentSpaceId, workspaceContext, loadError, bootstrap, setCurrentSpace, setModule } = useCrux()
  const [reading, setReading] = useState(false)
  const [orgModalOpen, setOrgModalOpen] = useState(false)
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false)
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const global = variant === 'global'
  const current = snapshot?.spaces.find((space) => space.id === currentSpaceId)
  const actor = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot?.members.find((member) => member.role === 'owner')?.id : undefined)
  const joined = global && workspaceContext.state === 'access-revoked' ? [] : snapshot?.spaces.filter((space) => !space.archived && actor && space.memberIds.includes(actor)) ?? []
  const orgTitle = workspaceContext.state === 'local' ? '本机模式' : workspaceContext.projectName ?? '团队组织'
  const activeSpace = joined.find((space) => space.id === currentSpaceId)
  const name = global ? (activeSpace ? `${orgTitle} · ${activeSpace.name}` : orgTitle) : current?.name ?? orgTitle
  const status = workspaceContext.state === 'offline' ? '离线缓存' : workspaceContext.state === 'access-revoked' ? '登录已过期' : ''
  const refreshOnOpen = (): void => {
    if (!global || !hasIpc) return
    const ticket = ++request.current
    setReading(true)
    void bootstrap().finally(() => { if (ticket === request.current) setReading(false) })
  }
  return <>
    <div className={global ? 'no-drag my-header-team' : 'no-drag flex min-w-0 items-center gap-2'}>
      <Dropdown width={260} className={global ? 'my-header-team-menu' : undefined} placement={global ? 'bottom' : 'auto'} trigger={({ toggle, open }) => {
        const button = <Button variant="ghost" className={global ? 'my-header-team-trigger' : 'my-project-switcher min-w-0'} onClick={() => { if (!open) refreshOnOpen(); toggle() }} aria-expanded={open} aria-label={`切换组织与空间${global ? `，当前${name}${status ? ` · ${status}` : ''}` : ''}`}>
          <Layers size={16} strokeWidth={1.7} aria-hidden="true" />
          <span className={global ? 'my-header-team-name my-item-title' : 'my-project-switcher-name max-w-64 truncate'}>{name}</span>
          <ChevronDown size={12} strokeWidth={1.7} className={clsx('my-trigger-chevron shrink-0 text-my-icon-tertiary transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
        return global ? <Tooltip side="bottom" label={`${name}${status ? ` · ${status}` : ''}`} wrap>{button}</Tooltip> : button
      }}>
        {(close) => <>
          <DropdownHeader>{orgTitle}{status ? ` · ${status}` : ''}</DropdownHeader>
          {global && <>
            {reading && <p role="status" className="my-item-description px-2.5 py-1">正在同步空间…</p>}
            {!hasIpc && <p className="my-item-description px-2.5 py-1">桌面端可连接团队组织</p>}
            {hasIpc && loadError && <p role="alert" className="px-2.5 py-1 text-my-xs text-my-danger-text">{loadError}</p>}
            {hasIpc && !reading && !loadError && !status && snapshot && actor && joined.length === 0 && (
              <p className="my-item-description px-2.5 py-1">当前组织下暂无已加入的空间</p>
            )}
          </>}
          {joined.map((space) => (
            <DropdownItem key={space.id} selected={space.id === currentSpaceId} disabled={global && reading} onClick={() => {
              if (global) {
                const latest = useCrux.getState()
                if (latest.workspaceContext.key !== workspaceContext.key || latest.workspaceContext.actorId !== workspaceContext.actorId || latest.workspaceContext.state === 'access-revoked' || !latest.snapshot?.spaces.some((item) => item.id === space.id && !item.archived && item.memberIds.includes(actor ?? ''))) return
              }
              if (selectOpensTasks) { setCurrentSpace(space.id); setModule('board') }
              else useCrux.setState({ currentSpaceId: space.id })
              close()
            }}>
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              <span className="font-mono text-my-2xs text-my-tertiary">{space.key}</span>
            </DropdownItem>
          ))}
          <DropdownDivider />
          {hasIpc && workspaceContext.canManage && workspaceContext.state !== 'access-revoked' && (
            <DropdownItem icon={<Plus size={14} />} onClick={() => { close(); setCreateSpaceOpen(true) }}>新建空间</DropdownItem>
          )}
          <DropdownItem icon={<Settings2 size={14} />} onClick={() => { setModule('spaces'); onManageSpaces?.(); close() }}>空间设置</DropdownItem>
          {hasIpc && (
            <DropdownItem icon={<Building2 size={14} />} onClick={() => { close(); setOrgModalOpen(true) }}>
              {workspaceContext.state === 'local' ? '登录或创建组织' : '切换 / 创建组织'}
            </DropdownItem>
          )}
        </>}
      </Dropdown>
    </div>
    {hasIpc && <ConnectionPanel hideTrigger open={orgModalOpen} onOpenChange={setOrgModalOpen} />}
    <Modal open={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} width={760} ariaLabel="新建空间">
      <SpaceSetupWizard
        mode="create"
        organizationName={orgTitle}
        onCancel={() => setCreateSpaceOpen(false)}
        onComplete={(spaceId) => {
          setCurrentSpace(spaceId)
          setModule('board')
          setCreateSpaceOpen(false)
          useApp.getState().setPage('crux')
        }}
      />
    </Modal>
  </>
}
