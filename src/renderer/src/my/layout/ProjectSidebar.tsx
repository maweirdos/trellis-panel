// 项目侧边栏：项目头 + Work items / 文档组 / 待办池 导航。
import { type JSX } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, Cog, Star } from 'lucide-react'
import { useApp } from '../../store'
import { useMy } from '../store'
import { NavIcon, WorkspaceMark } from '../icons'

const DOC_ITEMS: Array<{ id: string; label: string; icon: string }> = [
  { id: 'knowledge', label: '知识库', icon: 'pages' },
  { id: 'spec', label: '规范文档', icon: 'views' },
  { id: 'archive', label: '归档', icon: 'intake' }
]

export function ProjectSidebar(): JSX.Element {
  const data = useMy((s) => s.data)
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const project = data.projects[0]
  const taskCount = useApp((s) => s.snapshot?.tasks.length ?? 0)

  const navButton = (id: string, label: string, icon: string, count?: number): JSX.Element => (
    <button
      key={id}
      type="button"
      onClick={() => setPage(id as never)}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
        page === id ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
      )}
    >
      <NavIcon name={icon} size={16} className={page === id ? 'text-my-icon-primary' : 'text-my-icon-tertiary'} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="rounded bg-my-layer-3 px-1 text-[10px] font-semibold text-my-tertiary">{count}</span>
      )}
    </button>
  )

  return (
    <aside className="flex h-full w-[200px] shrink-0 flex-col border-r border-my-line bg-my-canvas">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3">
        <button
          type="button"
          onClick={() => setPage('dashboard')}
          title="返回 Your work"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <ChevronLeft size={14} />
        </button>
        <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={18} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{project.name}</span>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <Star size={12} className="fill-current text-my-warning" />
        </button>
        <button
          type="button"
          onClick={() => setPage('settings')}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <Cog size={12} />
        </button>
      </div>

      <div className="my-scrollbar min-h-0 flex-1 px-2.5 pb-3 pt-1">
        <div className="flex flex-col gap-0.5">{navButton('tasks', 'Work items', 'work-items', taskCount)}</div>
        <div className="mt-3 flex flex-col gap-0.5 border-t border-my-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-medium text-my-tertiary">文档</div>
          {DOC_ITEMS.map((item) => navButton(item.id, item.label, item.icon))}
        </div>
        <div className="mt-3 flex flex-col gap-0.5 border-t border-my-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-medium text-my-tertiary">跟踪</div>
          {navButton('inbox', '待办池', 'intake')}
        </div>
      </div>
    </aside>
  )
}
