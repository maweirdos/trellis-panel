// 项目侧边栏：项目头 + Work items/Cycles/Modules/Views/Pages/Intake 导航。
import { type JSX } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, Cog, Star } from 'lucide-react'
import { useMy } from '../store'
import { NavIcon, WorkspaceMark } from '../icons'
import type { MyPage } from '../types'

const SECTIONS: Array<{ items: Array<{ id: MyPage; label: string; icon: string }> }> = [
  {
    items: [
      { id: 'work-items', label: 'Work items', icon: 'work-items' },
      { id: 'cycles', label: 'Cycles', icon: 'cycles' },
      { id: 'modules', label: 'Modules', icon: 'modules' },
      { id: 'views', label: 'Views', icon: 'views' }
    ]
  },
  {
    items: [
      { id: 'pages', label: 'Pages', icon: 'pages' },
      { id: 'intake', label: 'Intake', icon: 'intake' }
    ]
  }
]

export function ProjectSidebar(): JSX.Element {
  const project = useMy((s) => s.data.projects.find((p) => p.id === s.activeProjectId)) ?? useMy((s) => s.data.projects[0])
  const page = useMy((s) => s.page)
  const navigateProject = useMy((s) => s.navigateProject)
  const navigateWorkspace = useMy((s) => s.navigateWorkspace)
  const toggleFavorite = useMy((s) => s.toggleProjectFavorite)
  const intakeCount = useMy((s) => s.data.intake.filter((i) => i.projectId === s.activeProjectId && i.status === 'pending').length)

  return (
    <aside className="flex h-full w-[200px] shrink-0 flex-col border-r border-my-line bg-my-canvas">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3">
        <button
          type="button"
          onClick={() => navigateWorkspace('projects')}
          title="返回项目列表"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <ChevronLeft size={14} />
        </button>
        <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={18} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{project.name}</span>
        <button
          type="button"
          onClick={() => toggleFavorite(project.id)}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <Star size={12} className={clsx(project.favorite && 'fill-current text-my-warning')} />
        </button>
        <button
          type="button"
          onClick={() => navigateProject(project.id, 'project-settings')}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-my-icon-tertiary hover:bg-my-layer-transparent-hover"
        >
          <Cog size={12} />
        </button>
      </div>

      <div className="my-scrollbar min-h-0 flex-1 px-2.5 pb-3 pt-1">
        {SECTIONS.map((section, si) => (
          <div key={si} className={clsx('flex flex-col gap-0.5', si > 0 && 'mt-3 border-t border-my-line pt-3')}>
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateProject(project.id, item.id)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
                  page === item.id ? 'bg-my-layer-transparent-active text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'
                )}
              >
                <NavIcon name={item.icon} size={16} className={page === item.id ? 'text-my-icon-primary' : 'text-my-icon-tertiary'} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.id === 'intake' && intakeCount > 0 && (
                  <span className="rounded bg-my-layer-3 px-1 text-[10px] font-semibold text-my-tertiary">{intakeCount}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
