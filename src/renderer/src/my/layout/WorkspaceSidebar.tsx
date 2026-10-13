// 工作区侧边栏：工作区切换器 / 搜索入口 / 导航 / 项目列表 / 用户菜单。
import { useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, CircleUser, Cog, PanelLeftClose, Plus, Search, Star } from 'lucide-react'
import { useMy } from '../store'
import { Avatar, Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../ui'
import { NavIcon, WorkspaceMark } from '../icons'
import type { MyPage } from '../types'

const NAV_ITEMS: Array<{ id: MyPage; label: string; icon: string }> = [
  { id: 'your-work', label: 'Your work', icon: 'your-work' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' }
]

export function WorkspaceSidebar({ onCollapse }: { onCollapse?: () => void }): JSX.Element {
  const data = useMy((s) => s.data)
  const page = useMy((s) => s.page)
  const navigateWorkspace = useMy((s) => s.navigateWorkspace)
  const navigateProject = useMy((s) => s.navigateProject)
  const toggleFavorite = useMy((s) => s.toggleProjectFavorite)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const setCreateProjectOpen = useMy((s) => s.setCreateProjectOpen)
  const theme = useMy((s) => s.theme)
  const setTheme = useMy((s) => s.setTheme)
  const me = data.members.find((m) => m.id === data.workspace.memberId) ?? data.members[0]
  const unread = data.notifications.filter((n) => !n.read).length
  const favorites = data.projects.filter((p) => p.favorite)
  const others = data.projects.filter((p) => !p.favorite)

  const ProjectRow = ({ id, name, icon, color, active }: { id: string; name: string; icon: string; color: string; active: boolean }): JSX.Element => (
    <button
      type="button"
      onClick={() => navigateProject(id)}
      className={clsx(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
        active ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
      )}
    >
      <WorkspaceMark color={color} letter={icon.slice(0, 1)} size={18} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          toggleFavorite(id)
        }}
        className={clsx('opacity-0 transition-opacity group-hover:opacity-100', active && 'opacity-60')}
      >
        <Star size={12} className="fill-current text-my-icon-placeholder" />
      </span>
    </button>
  )

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-my-line bg-my-canvas">
      {/* 工作区切换器 */}
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-3">
        <Dropdown
          width={240}
          className="min-w-0 flex-1"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 hover:bg-my-layer-transparent-hover"
            >
              <WorkspaceMark color="#006399" letter="星" size={22} />
              <span className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-my-primary">
                {data.workspace.name}
              </span>
              <ChevronDown size={13} className="shrink-0 text-my-icon-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <div>
              <DropdownHeader>工作区</DropdownHeader>
              <DropdownItem selected onClick={close}>
                {data.workspace.name}
              </DropdownItem>
              <div className="my-1 border-t border-my-line" />
              <DropdownItem icon={<CircleUser size={13} />} onClick={() => { navigateWorkspace('profile'); close() }}>
                Profile
              </DropdownItem>
              <DropdownItem
                icon={<Cog size={13} />}
                onClick={() => {
                  navigateWorkspace('workspace-settings')
                  close()
                }}
              >
                Workspace settings
              </DropdownItem>
              <DropdownItem
                icon={theme === 'dark' ? '☀️' : '🌙'}
                onClick={() => {
                  setTheme(theme === 'dark' ? 'light' : 'dark')
                  close()
                }}
              >
                切换浅色 / 深色主题
              </DropdownItem>
            </div>
          )}
        </Dropdown>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      {/* 搜索入口 */}
      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 w-full items-center gap-2 rounded-md border border-my-line bg-my-layer-2 px-2 text-my-tertiary hover:border-my-line-1"
        >
          <Search size={12} />
          <span className="min-w-0 flex-1 truncate text-left text-[12px]">Search or type a command...</span>
          <span className="my-kbd">⌘K</span>
        </button>
      </div>

      {/* 导航 */}
      <div className="flex flex-col gap-0.5 px-2.5 pb-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigateWorkspace(item.id)}
            className={clsx(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
              page === item.id ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
            )}
          >
            <NavIcon name={item.icon} size={16} className={page === item.id ? 'text-my-icon-primary' : 'text-my-icon-tertiary'} />
            <span className="flex-1 text-left">{item.label}</span>
            {item.id === 'inbox' && unread > 0 && (
              <span className="rounded-full bg-my-accent px-1.5 text-[10px] font-semibold leading-4 text-my-on-color">{unread}</span>
            )}
          </button>
        ))}
      </div>

      {/* 项目列表 */}
      <div className="my-scrollbar min-h-0 flex-1 px-2.5 pb-2">
        <div className="flex items-center justify-between px-2 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-my-tertiary">Projects</span>
          <Tooltip label="新建项目">
            <button
              type="button"
              onClick={() => setCreateProjectOpen(true)}
              className="flex h-4 w-4 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
        </div>
        {favorites.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-my-tertiary">收藏</div>
            <div className="flex flex-col gap-0.5">
              {favorites.map((p) => (
                <ProjectRow key={p.id} id={p.id} name={p.name} icon={p.icon} color={p.color} active={page !== 'your-work' && useMy.getState().activeProjectId === p.id} />
              ))}
            </div>
          </>
        )}
        <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-my-tertiary">全部项目</div>
        <div className="flex flex-col gap-0.5">
          {others.map((p) => (
            <ProjectRow
              key={p.id}
              id={p.id}
              name={p.name}
              icon={p.icon}
              color={p.color}
              active={page !== 'your-work' && useMy.getState().activeProjectId === p.id}
            />
          ))}
        </div>
      </div>

      {/* 用户 */}
      <div className="border-t border-my-line p-2">
        <Dropdown
          width={200}
          align="left"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-my-layer-transparent-hover"
            >
              <Avatar name={me.name} color={me.avatarColor} size={22} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12.5px] font-medium text-my-primary">{me.name}</span>
              </span>
              <ChevronDown size={12} className="text-my-icon-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <div>
              <DropdownHeader>{me.name} · {me.role}</DropdownHeader>
              <DropdownItem icon={<CircleUser size={13} />} onClick={() => { navigateWorkspace('profile'); close() }}>
                Profile & 偏好
              </DropdownItem>
              <DropdownItem
                icon={<Cog size={13} />}
                onClick={() => {
                  navigateWorkspace('workspace-settings')
                  close()
                }}
              >
                Workspace settings
              </DropdownItem>
            </div>
          )}
        </Dropdown>
      </div>
    </aside>
  )
}
