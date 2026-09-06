import {
  LayoutDashboard,
  Inbox,
  SquareKanban,
  BookOpenText,
  Users,
  Archive,
  Settings,
  FolderOpen,
  RotateCw,
  Link2,
  GitPullRequestArrow,
  Bot
} from 'lucide-react'
import { useApp, type Page } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const NAV: Array<{ id: Page; label: string; icon: JSX.Element }> = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard size={16} /> },
  { id: 'inbox', label: '收件箱', icon: <Inbox size={16} /> },
  { id: 'tasks', label: '任务看板', icon: <SquareKanban size={16} /> },
  { id: 'ai', label: 'AI 工作台', icon: <Bot size={16} /> },
  { id: 'spec', label: '规范文档', icon: <BookOpenText size={16} /> },
  { id: 'workspace', label: '工作区', icon: <Users size={16} /> },
  { id: 'archive', label: '归档', icon: <Archive size={16} /> },
  { id: 'team', label: '团队协作', icon: <GitPullRequestArrow size={16} /> },
  { id: 'jira', label: 'Jira 任务', icon: <Link2 size={16} /> },
  { id: 'settings', label: '设置', icon: <Settings size={16} /> }
]

export function Sidebar(): JSX.Element {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const snapshot = useApp((s) => s.snapshot)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const refresh = useApp((s) => s.refresh)
  const inbox = useApp((s) => s.inbox)

  const pendingCount = Object.values(inbox).filter((e) => e.state === 'pending').length
  const aiRunning = useApp((s) => s.aiRuns.filter((r) => r.status === 'running').length)

  const counts: Partial<Record<Page, number>> = snapshot
    ? {
        tasks: snapshot.tasks.length,
        archive: snapshot.archived.length,
        spec: countFiles(snapshot.spec)
      }
    : {}

  const badge = (id: Page): number | undefined => {
    if (id === 'inbox' && pendingCount > 0) return pendingCount
    if (id === 'ai' && aiRunning > 0) return aiRunning
    return counts[id]
  }

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-ink-700 bg-ink-850/60">
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5 pt-3">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            className={clsx(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] transition-colors',
              page === item.id
                ? 'bg-leaf-dim/15 font-medium text-leaf-soft'
                : 'text-mist-300 hover:bg-ink-700/50 hover:text-mist-100'
            )}
          >
            <span className={page === item.id ? 'text-leaf' : 'text-mist-400'}>{item.icon}</span>
            {item.label}
            {badge(item.id) !== undefined && badge(item.id)! > 0 && (
              <span
                className={clsx(
                  'ml-auto rounded px-1.5 font-mono text-[10.5px]',
                  item.id === 'inbox'
                    ? 'bg-amber-500/20 text-amber-300'
                    : item.id === 'ai'
                      ? 'bg-leaf-dim/25 text-leaf-soft'
                      : 'bg-ink-750 text-mist-400'
                )}
              >
                {badge(item.id)}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="space-y-1.5 border-t border-ink-700 p-3">
        {snapshot && (
          <div className="space-y-1 text-[11px] leading-4 text-mist-400">
            {snapshot.meta.developer && (
              <div>
                开发者 <span className="text-mist-200">{snapshot.meta.developer}</span>
              </div>
            )}
            {snapshot.meta.currentTask && (
              <div className="truncate" title={snapshot.meta.currentTask}>
                当前任务 <span className="font-mono text-leaf-soft/90">{snapshot.meta.currentTask}</span>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-1.5 pt-0.5">
          <button onClick={pickAndOpen} className="btn-ghost flex-1 justify-center" title="打开项目">
            <FolderOpen size={13} /> 打开
          </button>
          <button onClick={refresh} className="btn-ghost justify-center px-2" title="重新扫描">
            <RotateCw size={13} />
          </button>
        </div>
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
