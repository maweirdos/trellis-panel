// 工作区侧边栏：工作区切换器 / 搜索入口 / 一级导航 / 项目入口 / 用户。
import { type JSX } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, CircleUser, FolderOpen, PanelLeftClose, Plus, Search } from 'lucide-react'
import { useApp } from '../../store'
import { useMy } from '../store'
import { Avatar, Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../ui'
import { NavIcon, WorkspaceMark } from '../icons'

export function WorkspaceSidebar({ onCollapse }: { onCollapse?: () => void }): JSX.Element {
  const data = useMy((s) => s.data)
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const snapshot = useApp((s) => s.snapshot)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const theme = useMy((s) => s.theme)
  const toggleTheme = useMy((s) => s.toggleTheme)
  const me = data.members.find((m) => m.id === data.workspace.memberId) ?? data.members[0]
  const project = data.projects[0]

  const NAV_ITEMS: Array<{ id: string; label: string; icon: string }> = [
    { id: 'dashboard', label: '我的工作', icon: 'your-work' },
    { id: 'analytics', label: '统计分析', icon: 'analytics' }
  ]

  const COLLAB_ITEMS: Array<{ id: string; label: string; icon: string }> = [
    { id: 'channels', label: 'AI 频道', icon: 'inbox' },
    { id: 'acp', label: 'Agent 会话', icon: 'intake' },
    { id: 'team', label: '团队协作', icon: 'views' },
    { id: 'jira', label: 'Jira 任务', icon: 'work-items' }
  ]

  const SYSTEM_ITEMS: Array<{ id: string; label: string; icon: string }> = [
    { id: 'architecture', label: '架构图', icon: 'views' },
    { id: 'studio', label: '定制中心', icon: 'modules' },
    { id: 'models', label: '模型管理', icon: 'cycles' },
    { id: 'gateway', label: 'MCP 网关', icon: 'analytics' },
    { id: 'settings', label: '设置', icon: 'work-items' }
  ]

  const navButton = (id: string, label: string, icon: string, badge?: number): JSX.Element => (
    <button
      key={id}
      type="button"
      onClick={() => setPage(id as never)}
      className={clsx(
        'flex w-full items-center gap-2 rounded-my-md px-2 py-1.5 text-my-md',
        page === id ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
      )}
    >
      <NavIcon name={icon} size={16} className={page === id ? 'text-my-icon-primary' : 'text-my-icon-tertiary'} />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-my-accent px-1.5 text-my-2xs font-semibold leading-4 text-my-on-color">{badge}</span>
      )}
    </button>
  )

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-my-line bg-my-canvas">
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-3">
        <Dropdown
          width={240}
          className="min-w-0 flex-1"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center gap-2 rounded-my-md px-1.5 py-1 hover:bg-my-layer-transparent-hover"
            >
              <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={22} />
              <span className="min-w-0 flex-1 truncate text-left text-my-lg font-medium text-my-primary">
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
              <DropdownItem icon={<CircleUser size={13} />} onClick={() => { setPage('settings'); close() }}>
                设置
              </DropdownItem>
              <DropdownItem
                icon={theme === 'dark' ? '☀️' : '🌙'}
                onClick={() => {
                  toggleTheme()
                  close()
                }}
              >
                切换浅色 / 深色主题
              </DropdownItem>
              <DropdownItem
                icon={<FolderOpen size={13} />}
                onClick={() => {
                  void pickAndOpen()
                  close()
                }}
              >
                打开本地其他项目
              </DropdownItem>
            </div>
          )}
        </Dropdown>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-my-md text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 w-full items-center gap-2 rounded-my-md border border-my-line bg-my-layer-2 px-2 text-my-tertiary hover:border-my-line-1"
        >
          <Search size={12} />
          <span className="min-w-0 flex-1 truncate text-left text-my-sm">搜索或输入命令…</span>
          <span className="my-kbd">⌘K</span>
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pb-1">
        {NAV_ITEMS.map((item) => navButton(item.id, item.label, item.icon))}
      </div>

      <div className="my-scrollbar min-h-0 flex-1 px-2.5 pb-2">
        <div className="flex items-center justify-between px-2 pb-1 pt-2">
          <span className="text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">项目</span>
          <Tooltip label="新建工作项">
            <button
              type="button"
              onClick={() => setCreateIssueOpen(true)}
              className="flex h-4 w-4 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
        </div>
        <button
          type="button"
          onClick={() => setPage('tasks')}
          className={clsx(
            'group flex w-full items-center gap-2 rounded-my-md px-2 py-1.5 text-left text-my-md',
            page === 'tasks' ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
          )}
        >
          <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={18} />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="text-my-xs text-my-tertiary">{snapshot?.tasks.length ?? 0}</span>
        </button>

        <div className="mt-3 border-t border-my-line pt-3" />
        <div className="px-2 pb-1 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">协作</div>
        <div className="flex flex-col gap-0.5">{COLLAB_ITEMS.map((item) => navButton(item.id, item.label, item.icon))}</div>

        <div className="mt-3 border-t border-my-line pt-3" />
        <div className="px-2 pb-1 text-my-xs font-semibold uppercase tracking-wider text-my-tertiary">系统</div>
        <div className="flex flex-col gap-0.5">{SYSTEM_ITEMS.map((item) => navButton(item.id, item.label, item.icon))}</div>
      </div>

      <div className="border-t border-my-line p-2">
        <Dropdown
          width={200}
          align="left"
          trigger={({ toggle }) => (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center gap-2 rounded-my-md px-1.5 py-1.5 hover:bg-my-layer-transparent-hover"
            >
              <Avatar name={me.name} color={me.avatarColor} size={22} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-my-sm font-medium text-my-primary">{me.name}</span>
              </span>
              <ChevronDown size={12} className="text-my-icon-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <div>
              <DropdownHeader>{me.name} · {me.role === 'Admin' ? '管理员' : me.role === 'Member' ? '成员' : '访客'}</DropdownHeader>
              <DropdownItem icon={<CircleUser size={13} />} onClick={() => { setPage('settings'); close() }}>
                设置
              </DropdownItem>
              <DropdownItem
                icon={theme === 'dark' ? '☀️' : '🌙'}
                onClick={() => {
                  toggleTheme()
                  close()
                }}
              >
                切换浅色 / 深色主题
              </DropdownItem>
            </div>
          )}
        </Dropdown>
      </div>
    </aside>
  )
}
