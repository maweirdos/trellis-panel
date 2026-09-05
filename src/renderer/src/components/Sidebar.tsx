import {
  LayoutDashboard,
  SquareKanban,
  BookOpenText,
  Users,
  Archive,
  SquareTerminal,
  Settings,
  FolderOpen,
  RotateCw
} from 'lucide-react'
import { useApp, type Page } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'

const NAV: Array<{ id: Page; label: string; icon: JSX.Element }> = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard size={16} /> },
  { id: 'tasks', label: '任务看板', icon: <SquareKanban size={16} /> },
  { id: 'spec', label: '规范文档', icon: <BookOpenText size={16} /> },
  { id: 'workspace', label: '工作区', icon: <Users size={16} /> },
  { id: 'archive', label: '归档', icon: <Archive size={16} /> },
  { id: 'cli', label: 'CLI 终端', icon: <SquareTerminal size={16} /> },
  { id: 'settings', label: '设置', icon: <Settings size={16} /> }
]

export function Sidebar(): JSX.Element {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const snapshot = useApp((s) => s.snapshot)
  const pickAndOpen = useApp((s) => s.pickAndOpen)
  const refresh = useApp((s) => s.refresh)

  const counts: Partial<Record<Page, number>> = snapshot
    ? {
        tasks: snapshot.tasks.length,
        archive: snapshot.archived.length,
        spec: countFiles(snapshot.spec)
      }
    : {}

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
            {counts[item.id] !== undefined && counts[item.id]! > 0 && (
              <span className="ml-auto rounded bg-ink-750 px-1.5 text-[10.5px] font-mono text-mist-400">
                {counts[item.id]}
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
