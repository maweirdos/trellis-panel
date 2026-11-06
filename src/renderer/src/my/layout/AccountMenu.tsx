import { useState, type JSX } from 'react'
import { CircleUser, Moon, Sun, Users } from 'lucide-react'
import { hasIpc } from '../../api'
import { useApp } from '../../store'
import { ConnectionPanel } from '../../hifox/ConnectionPanel'
import { useHifox } from '../../hifox/store'
import { useMy } from '../store'
import { Avatar, Button, Dropdown, DropdownItem, Tooltip } from '../ui'

export function AccountMenu(): JSX.Element {
  const setPage = useApp((state) => state.setPage)
  const snapshot = useApp((state) => state.snapshot)
  const theme = useMy((state) => state.theme)
  const toggleTheme = useMy((state) => state.toggleTheme)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const accountContext = useHifox((state) => state.workspaceContext)
  const accountName = useHifox((state) => state.snapshot?.members.find((member) => member.id === state.workspaceContext.actorId)?.name)
  const inLocalMode = accountContext.state === 'local'
  const visibleAccount = inLocalMode ? snapshot?.meta.developer ?? '本机用户' : accountName ?? '团队账号待核对'
  return <>
    <Dropdown className="my-rail-account" align="left" placement="top" gap={8} width={210} trigger={({ open, toggle }) => <Tooltip side="top" label={`账号与主题 · ${visibleAccount}`} wrap>
      <Button variant="ghost" aria-label="账号与主题" aria-haspopup="menu" aria-expanded={open} onClick={toggle} className="my-rail-account-trigger"><Avatar name={visibleAccount} color="var(--my-bg-accent-primary)" tone="accent" size={28} /></Button>
    </Tooltip>}>
      {(close) => <>
        <div className="my-item-title px-3 py-2">{visibleAccount}<span className="my-item-description mt-1 block">{inLocalMode ? '本机使用 · 无需登录' : accountContext.state === 'connected' ? '团队账号' : accountContext.state === 'offline' ? '团队账号 · 离线缓存' : '团队账号 · 权限失效'}</span></div>
        <DropdownItem disabled={!hasIpc} icon={<Users size={14} />} onClick={() => { close(); setConnectionsOpen(true) }}>账号、组织与工作区</DropdownItem>
        {!hasIpc && <p className="my-item-description px-3 py-1">桌面端可管理账号与工作区</p>}
        <DropdownItem icon={<CircleUser size={14} />} onClick={() => { useMy.getState().setSettingsView('preferences'); setPage('settings'); close() }}>通用设置</DropdownItem>
        <DropdownItem icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />} onClick={() => { toggleTheme(); close() }}>切换{theme === 'dark' ? '亮色' : '深色'}主题</DropdownItem>
      </>}
    </Dropdown>
    <ConnectionPanel hideTrigger open={connectionsOpen} onOpenChange={setConnectionsOpen} />
  </>
}
