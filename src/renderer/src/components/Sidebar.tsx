import {
  LayoutDashboard,
  Inbox,
  SquareKanban,
  BookOpenText,
  Archive,
  Settings,
  FolderOpen,
  RotateCw,
  Link2,
  GitPullRequestArrow,
  Library,
  Wand2,
  Radio,
  Network,
  Boxes,
  BrainCircuit,
  PanelLeftClose,
  PanelLeftOpen,
  User
} from 'lucide-react'
import { useApp, type Page } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const GROUPS: Array<{ label: string; items: Array<{ id: Page; label: string; icon: JSX.Element }> }> = [
  {
    label: '工作台',
    items: [
      { id: 'dashboard', label: '概览', icon: <LayoutDashboard size={16} /> },
      { id: 'inbox', label: '待办池', icon: <Inbox size={16} /> },
      { id: 'tasks', label: '任务看板', icon: <SquareKanban size={16} /> }
    ]
  },
  {
    label: '知识',
    items: [
      { id: 'knowledge', label: '知识库', icon: <Library size={16} /> },
      { id: 'spec', label: '规范文档', icon: <BookOpenText size={16} /> },
      { id: 'archive', label: '归档', icon: <Archive size={16} /> }
    ]
  },
  {
    label: '协作',
    items: [
      { id: 'channels', label: 'AI 频道', icon: <Radio size={16} /> },
      { id: 'team', label: '团队协作', icon: <GitPullRequestArrow size={16} /> },
      { id: 'jira', label: 'Jira 任务', icon: <Link2 size={16} /> }
    ]
  },
  {
    label: '系统',
    items: [
      { id: 'architecture', label: '架构图', icon: <Network size={16} /> },
      { id: 'studio', label: '定制中心', icon: <Wand2 size={16} /> },
      { id: 'models', label: '模型管理', icon: <Boxes size={16} /> },
      { id: 'gateway', label: 'MCP 网关', icon: <BrainCircuit size={16} /> },
      { id: 'settings', label: '设置', icon: <Settings size={16} /> }
    ]
  }
]

export function Sidebar(): JSX.Element {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const snapshot = useApp((s) => s.snapshot)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const refresh = useApp((s) => s.refresh)
  const todos = useApp((s) => s.todos)
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed)
  const toggleSidebar = useApp((s) => s.toggleSidebar)

  const pendingCount = todos.filter((e) => e.status === 'pending').length

  const counts: Partial<Record<Page, number>> = snapshot
    ? {
        tasks: snapshot.tasks.length,
        archive: snapshot.archived.length,
        spec: countFiles(snapshot.spec)
      }
    : {}

  const badge = (id: Page): number | undefined => {
    if (id === 'inbox' && pendingCount > 0) return pendingCount
    return counts[id]
  }

  return (
    <aside
      className={clsx(
        'flex shrink-0 flex-col border-r border-ink-700 bg-ink-850 transition-all duration-200 ease-in-out',
        sidebarCollapsed ? 'w-14' : 'w-52'
      )}
    >
      <nav className={clsx('flex-1 space-y-2 overflow-y-auto', sidebarCollapsed ? 'p-1.5 pt-3' : 'p-2.5 pt-3')}>
        {GROUPS.map((group, gIdx) => (
          <div key={group.label}>
            {sidebarCollapsed ? (
              gIdx > 0 && <div className="my-2 h-px bg-ink-750/70" />
            ) : (
              <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-mist-600">{group.label}</div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const count = badge(item.id)
                const hasBadge = count !== undefined && count > 0
                return (
                  <button
                    key={item.id}
                    onClick={() => setPage(item.id)}
                    title={sidebarCollapsed ? `${item.label}${hasBadge ? ` (${count})` : ''}` : undefined}
                    className={clsx(
                      'relative flex w-full items-center rounded-lg text-[12.5px] transition-colors',
                      sidebarCollapsed ? 'justify-center p-2' : 'gap-2.5 px-2.5 py-[7px]',
                      page === item.id
                        ? 'bg-leaf-dim/15 font-medium text-leaf-soft'
                        : 'text-mist-300 hover:bg-ink-700/50 hover:text-mist-100'
                    )}
                  >
                    <span className={clsx(page === item.id ? 'text-leaf' : 'text-mist-400', 'relative')}>
                      {item.icon}
                      {sidebarCollapsed && hasBadge && (
                        <span
                          className={clsx(
                            'absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-ink-850',
                            item.id === 'inbox' ? 'bg-amber-400' : 'bg-mist-400'
                          )}
                        />
                      )}
                    </span>
                    {!sidebarCollapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        {hasBadge && (
                          <span
                            className={clsx(
                              'ml-auto rounded px-1.5 font-mono text-[10.5px]',
                              item.id === 'inbox'
                                ? 'border border-amber-500/30 bg-amber-500/15 font-medium text-amber-800 dark:text-amber-300'
                                : 'bg-ink-750 text-mist-400'
                            )}
                          >
                            {count}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部控制与工作状态：精炼的用户与工作区状态卡片 */}
      <div className={clsx('border-t border-ink-700/80 bg-ink-850/60', sidebarCollapsed ? 'p-1.5' : 'p-2.5 space-y-2')}>
        {!sidebarCollapsed && snapshot && (
          <div
            className="group relative flex items-center gap-2.5 rounded-xl border border-ink-700/60 bg-ink-800/80 p-2.5 transition-all hover:border-ink-600/80 hover:bg-ink-800 shadow-xs"
            title={`当前工作区: ${snapshot.meta.name}\n根路径: ${snapshot.meta.root}\n开发者: ${snapshot.meta.developer || '未配置'}`}
          >
            {/* 开发者首字母头像徽章 */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-leaf-dim/15 border border-leaf-dim/30 font-mono text-xs font-semibold text-leaf-soft shadow-xs">
              {(snapshot.meta.developer || 'U').slice(0, 1).toUpperCase()}
            </div>

            {/* 开发者与工作就绪状态（聚焦身份与实时状态，杜绝与顶部项目名重复） */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-semibold text-mist-100">
                  {snapshot.meta.developer || '开发者'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 pt-0.5 text-[11px]">
                {snapshot.meta.currentTask ? (
                  <span
                    className="flex min-w-0 items-center gap-1 font-mono text-[10px] font-medium text-leaf-soft"
                    title={`当前任务: ${snapshot.meta.currentTask}`}
                  >
                    <span className="relative flex h-1.5 w-1.5 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-leaf opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-leaf" />
                    </span>
                    <span className="truncate">{snapshot.meta.currentTask}</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[10.5px] font-medium text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                    就绪 · 活跃连接
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 水平工具条（展开状态横向排列，折叠状态垂直紧凑居中） */}
        {sidebarCollapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={pickAndOpen}
              className="btn-ghost justify-center rounded-lg p-2 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
              title="打开项目 (Open Project)"
            >
              <FolderOpen size={15} />
            </button>
            <button
              onClick={refresh}
              className="btn-ghost justify-center rounded-lg p-2 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
              title="重新扫描项目 (Refresh)"
            >
              <RotateCw size={15} />
            </button>
            <button
              onClick={toggleSidebar}
              className="btn-ghost justify-center rounded-lg p-2 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
              title="展开侧边栏"
            >
              <PanelLeftOpen size={15} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between px-0.5 pt-0.5">
            <div className="flex items-center gap-1">
              <button
                onClick={pickAndOpen}
                className="btn-ghost rounded-lg p-1.5 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
                title="打开本地其他项目"
              >
                <FolderOpen size={14} />
              </button>
              <button
                onClick={refresh}
                className="btn-ghost rounded-lg p-1.5 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
                title="重新扫描项目状态"
              >
                <RotateCw size={14} />
              </button>
            </div>

            <button
              onClick={toggleSidebar}
              className="btn-ghost rounded-lg p-1.5 text-mist-400 hover:bg-ink-700/60 hover:text-mist-100 active:scale-95 transition-all"
              title="收起侧边栏"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function countFiles(nodes: { type: string; children?: unknown[] }[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.type === 'file') n += 1
    else if (node.children) n += countFiles(node.children as never)
  }
  return n
}
