import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Laptop, Plus, Settings2 } from 'lucide-react'
import { clsx } from 'clsx'
import { hasIpc } from '../api'
import { useApp } from '../store'
import { Button, Dropdown, DropdownDivider, DropdownHeader, DropdownItem, Modal, Tooltip } from '../my/ui'
import { ConnectionPanel } from './ConnectionPanel'
import { desktopAccountAdapter } from './account/desktop-account-adapter'
import type { DesktopAccountGroup, DesktopWorkspaceChoice } from './account/model'
import { SpaceSetupWizard } from './account/SpaceSetupWizard'
import { identityTone } from './identity-tone'
import { useCrux } from './store'

function orgMonogram(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'OR'
  if (/^[A-Za-z0-9]/.test(trimmed)) return trimmed.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || trimmed.slice(0, 2).toUpperCase()
  return trimmed.slice(0, 1)
}

function OrgIdentityIcon({ name, local = false }: { name: string; local?: boolean }): JSX.Element {
  if (local) {
    return (
      <span
        className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-my-layer-3 text-my-icon-secondary"
        aria-hidden="true"
      >
        <Laptop size={12} strokeWidth={1.75} />
      </span>
    )
  }
  const monogram = orgMonogram(name)
  return (
    <span
      className="collab-tone-solid inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-my-2xs font-semibold leading-none tracking-tight"
      data-tone={identityTone(name)}
      aria-hidden="true"
    >
      <span style={monogram.length > 1 ? { transform: 'scale(0.86)' } : undefined}>{monogram}</span>
    </span>
  )
}

/** 顶栏组织切换器（对标 HiFox 左上角 [HO] honsky v：设置 -> 切换组织列表 -> + 创建组织）。 */
export function TeamContextSwitcher({ variant = 'default', selectOpensTasks = true, onManageSpaces }: {
  variant?: 'default' | 'global'
  selectOpensTasks?: boolean
  onManageSpaces?: () => void
} = {}): JSX.Element {
  const { snapshot, currentSpaceId, workspaceContext, bootstrap, selectWorkspace, setCurrentSpace, setModule } = useCrux()
  const [reading, setReading] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [accountGroups, setAccountGroups] = useState<DesktopAccountGroup[]>([])
  const [orgDialog, setOrgDialog] = useState<{ open: boolean; step: 'organizations' | 'create-organization' }>({ open: false, step: 'organizations' })
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false)
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])

  const global = variant === 'global'
  const current = snapshot?.spaces.find((space) => space.id === currentSpaceId)
  const orgTitle = workspaceContext.state === 'local' ? '本机工作台' : workspaceContext.projectName ?? '团队组织'
  const displayTitle = global ? orgTitle : (current?.name ?? orgTitle)
  const status = workspaceContext.state === 'offline' ? '离线缓存' : workspaceContext.state === 'access-revoked' ? '登录已过期' : ''

  const refreshOnOpen = (): void => {
    if (!hasIpc) return
    const ticket = ++request.current
    setReading(true)
    void Promise.all([
      bootstrap(),
      desktopAccountAdapter.loadConnectedAccounts(workspaceContext.connectionId).then((res) => {
        if (ticket === request.current) setAccountGroups(res.accounts)
      }).catch(() => undefined)
    ]).finally(() => { if (ticket === request.current) setReading(false) })
  }

  const switchToOrganization = async (group: DesktopAccountGroup, choice: DesktopWorkspaceChoice, close: () => void): Promise<void> => {
    if (switchingId) return
    setSwitchingId(choice.workspaceId ?? choice.connectionId ?? group.accountId)
    try {
      let connectionId = choice.connectionId
      if (!connectionId && choice.workspaceId && choice.organizationId && group.state === 'active') {
        const opened = await desktopAccountAdapter.openAccount(group.accountId)
        const ensured = await desktopAccountAdapter.ensureDeviceConnection({
          session: opened.session,
          organizationId: choice.organizationId,
          workspaceId: choice.workspaceId,
          currentConnectionId: workspaceContext.connectionId
        })
        connectionId = ensured.connectionId
      }
      if (connectionId) {
        const ok = await selectWorkspace(connectionId)
        if (ok) {
          useApp.getState().setPage('crux')
          if (selectOpensTasks) setModule('tasks')
          close()
        }
      } else {
        close()
        setOrgDialog({ open: true, step: 'organizations' })
      }
    } catch {
      close()
      setOrgDialog({ open: true, step: 'organizations' })
    } finally {
      setSwitchingId(null)
    }
  }

  const allWorkspaces = accountGroups.flatMap((group) =>
    group.workspaces.map((choice) => ({ group, choice }))
  )

  return <>
    <div className={global ? 'no-drag my-header-team' : 'no-drag flex min-w-0 items-center gap-2'}>
      <Dropdown width={240} gap={6} className={global ? 'my-header-team-menu' : undefined} placement={global ? 'bottom' : 'auto'} trigger={({ toggle, open }) => {
        const button = (
          <Button
            variant="ghost"
            className={global ? 'my-header-team-trigger gap-2' : 'my-project-switcher min-w-0 gap-2'}
            onClick={() => { if (!open) refreshOnOpen(); toggle() }}
            aria-expanded={open}
            aria-label={`组织菜单，${displayTitle}${status ? ` · ${status}` : ''}`}
          >
            <OrgIdentityIcon name={displayTitle} local={workspaceContext.state === 'local'} />
            <span className={global ? 'my-header-team-name my-item-title' : 'my-project-switcher-name max-w-64 truncate'}>{displayTitle}</span>
            <ChevronDown size={12} strokeWidth={1.7} className={clsx('my-trigger-chevron shrink-0 text-my-icon-tertiary transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </Button>
        )
        return global ? <Tooltip side="bottom" label={`${displayTitle}${status ? ` · ${status}` : ''}`} wrap>{button}</Tooltip> : button
      }}>
        {(close) => <>
          <DropdownItem
            className="my-org-menu-item"
            icon={<Settings2 size={14} strokeWidth={1.75} />}
            onClick={() => {
              setModule('spaces')
              onManageSpaces?.()
              useApp.getState().setPage('crux')
              close()
            }}
          >
            设置
          </DropdownItem>
          <DropdownDivider />
          <DropdownHeader>切换组织{reading ? ' · 同步中' : ''}</DropdownHeader>
          {allWorkspaces.map(({ group, choice }) => {
            const label = choice.organizationName ?? choice.workspaceName
            const isCurrent = workspaceContext.state !== 'local' && choice.current
            const choiceId = choice.workspaceId ?? choice.connectionId ?? group.accountId
            const itemKey = `${group.accountId}:${choice.workspaceId ?? choice.connectionId ?? label}`
            return (
              <DropdownItem
                key={itemKey}
                className="my-org-menu-item"
                icon={<OrgIdentityIcon name={label} />}
                selected={isCurrent}
                disabled={Boolean(switchingId)}
                trailing={switchingId === choiceId ? <span className="text-my-2xs text-my-tertiary">切换中…</span> : undefined}
                onClick={() => void switchToOrganization(group, choice, close)}
              >
                {label}
              </DropdownItem>
            )
          })}
          <DropdownItem
            className="my-org-menu-item"
            icon={<OrgIdentityIcon name="本机工作台" local />}
            selected={workspaceContext.state === 'local'}
            disabled={Boolean(switchingId)}
            onClick={() => {
              void selectWorkspace(null).then((ok) => {
                if (ok) useApp.getState().setPage('crux')
                close()
              })
            }}
          >
            本机工作台
          </DropdownItem>
          {hasIpc && allWorkspaces.length === 0 && !reading && (
            <DropdownItem
              className="my-org-menu-item"
              onClick={() => { close(); setOrgDialog({ open: true, step: 'organizations' }) }}
            >
              <span className="text-my-xs text-my-secondary">登录团队账号同步组织…</span>
            </DropdownItem>
          )}
          {hasIpc && <>
            <DropdownDivider />
            <DropdownItem
              className="my-org-menu-item"
              icon={<Plus size={14} strokeWidth={1.75} />}
              onClick={() => { close(); setOrgDialog({ open: true, step: 'create-organization' }) }}
            >
              创建组织
            </DropdownItem>
          </>}
        </>}
      </Dropdown>
    </div>
    {hasIpc && (
      <ConnectionPanel
        hideTrigger
        open={orgDialog.open}
        initialStep={orgDialog.step}
        onOpenChange={(open) => setOrgDialog((prev) => ({ ...prev, open }))}
      />
    )}
    <Modal open={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} width={760} ariaLabel="新建空间">
      <SpaceSetupWizard
        mode="create"
        organizationName={orgTitle}
        onCancel={() => setCreateSpaceOpen(false)}
        onComplete={(spaceId) => {
          setCurrentSpace(spaceId)
          setModule('tasks')
          setCreateSpaceOpen(false)
          useApp.getState().setPage('crux')
        }}
      />
    </Modal>
  </>
}
