/**
 * HiFox 协作工作区外壳：模块导航 + 空间切换 + 页面路由。
 * 挂载点：MyApp FRAMED_PAGES（PageBody 内，属交互上下文）。
 */
import { useEffect } from 'react'
import { Boxes, Bot, ChevronsUpDown, Filter, Inbox, KanbanSquare, ListTodo, Sparkles, Users2, Users, Workflow, Layers, CalendarRange, Wrench } from 'lucide-react'
import { useHifox, type HifoxModule } from './store'
import { api } from '../api'
import { Button } from '../my/ui'
import { PageHeader } from './ui'
import { OverviewPage } from './pages/OverviewPage'
import { TasksPage } from './pages/TasksPage'
import { BoardPage } from './pages/BoardPage'
import { InboxPage } from './pages/InboxPage'
import { TriagePage } from './pages/TriagePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { IterationsPage } from './pages/IterationsPage'
import { MembersPage } from './pages/MembersPage'
import { SpacesPage } from './pages/SpacesPage'
import { AgentsPage } from './pages/AgentsPage'
import { SkillsPage } from './pages/SkillsPage'
import { CrewsPage } from './pages/CrewsPage'
import { AutomationsPage } from './pages/AutomationsPage'

const MODULES: Array<{ id: HifoxModule; label: string; icon: JSX.Element; group: string }> = [
  { id: 'overview', label: '概况', icon: <Boxes size={15} />, group: '协作' },
  { id: 'tasks', label: '任务', icon: <ListTodo size={15} />, group: '协作' },
  { id: 'board', label: '看板', icon: <KanbanSquare size={15} />, group: '协作' },
  { id: 'inbox', label: '收件箱', icon: <Inbox size={15} />, group: '协作' },
  { id: 'triage', label: '分拣台', icon: <Filter size={15} />, group: '协作' },
  { id: 'projects', label: '专项', icon: <Layers size={15} />, group: '计划' },
  { id: 'iterations', label: '迭代', icon: <CalendarRange size={15} />, group: '计划' },
  { id: 'members', label: '成员', icon: <Users size={15} />, group: '组织' },
  { id: 'spaces', label: '空间与配置', icon: <Wrench size={15} />, group: '组织' },
  { id: 'agents', label: 'Agent', icon: <Bot size={15} />, group: 'Agent' },
  { id: 'skills', label: '技能', icon: <Sparkles size={15} />, group: 'Agent' },
  { id: 'crews', label: '小队', icon: <Users2 size={15} />, group: 'Agent' },
  { id: 'automations', label: '自动化', icon: <Workflow size={15} />, group: 'Agent' }
]

const GROUPS = ['协作', '计划', '组织', 'Agent']

export function HiFoxApp(): JSX.Element {
  const bootstrap = useHifox((s) => s.bootstrap)
  const snapshot = useHifox((s) => s.snapshot)
  const loadError = useHifox((s) => s.loadError)
  const module = useHifox((s) => s.module)
  const setModule = useHifox((s) => s.setModule)
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const setCurrentSpace = useHifox((s) => s.setCurrentSpace)

  useEffect(() => { void bootstrap() }, [bootstrap])

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md rounded-my-md border border-my-line bg-my-layer p-4 text-center text-my-sm text-my-secondary">{loadError}</p>
      </div>
    )
  }
  if (!snapshot) {
    return <div className="grid h-full place-items-center text-my-xs text-my-tertiary">正在加载 HiFox 协作数据…</div>
  }

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId) ?? snapshot.spaces[0]
  const unread = snapshot.inbox.filter((i) => !i.read && !i.cleared).length

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="HiFox 模块导航" className="flex w-44 shrink-0 flex-col border-r border-my-line">
        <div className="border-b border-my-line p-2">
          <label className="relative flex cursor-pointer items-center gap-2 rounded-my-md border border-my-line bg-my-layer px-2.5 py-2 text-my-sm text-my-primary hover:border-my-brand/50">
            <ChevronsUpDown size={13} className="text-my-tertiary" />
            <span className="min-w-0 flex-1 truncate">{space?.name ?? '选择空间'}</span>
            <select
              aria-label="切换空间"
              className="absolute inset-0 cursor-pointer opacity-0"
              value={space?.id ?? ''}
              onChange={(e) => setCurrentSpace(e.target.value)}
            >
              {snapshot.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {GROUPS.map((group) => (
            <div key={group} className="mb-3">
              <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-my-tertiary">{group}</p>
              {MODULES.filter((m) => m.group === group).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-current={module === m.id ? 'page' : undefined}
                  onClick={() => setModule(m.id)}
                  className={`flex min-h-8 w-full items-center gap-2 rounded-my-md px-2.5 py-1.5 text-left text-my-sm transition-colors ${module === m.id ? 'bg-my-layer-active font-medium text-my-primary' : 'text-my-secondary hover:bg-my-layer-transparent-hover'}`}
                >
                  {m.icon}
                  <span className="flex-1">{m.label}</span>
                  {m.id === 'inbox' && unread > 0 && <span className="rounded-full bg-red-500/20 px-1.5 text-[10px] font-medium text-red-400">{unread}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="border-t border-my-line px-3 py-2 text-[10px] leading-relaxed text-my-tertiary">
          Runtime 与集成模块由专门分支开发中；Agent 派发目前推进到「等待 Runtime」。
        </p>
      </nav>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col p-4" data-hifox-module={module}>
        {module === 'overview' && <OverviewPage />}
        {module === 'tasks' && <TasksPage />}
        {module === 'board' && <BoardPage />}
        {module === 'inbox' && <InboxPage />}
        {module === 'triage' && <TriagePage />}
        {module === 'projects' && <ProjectsPage />}
        {module === 'iterations' && <IterationsPage />}
        {module === 'members' && <MembersPage />}
        {module === 'spaces' && <SpacesPage />}
        {module === 'agents' && <AgentsPage />}
        {module === 'skills' && <SkillsPage />}
        {module === 'crews' && <CrewsPage />}
        {module === 'automations' && <AutomationsPage />}
      </main>
    </div>
  )
}

/** 各页面共用的重置演示数据入口 */
export function ResetDemoButton(): JSX.Element {
  const run = useHifox((s) => s.run)
  return (
    <Button variant="outline" size="sm" onClick={() => void run('重置演示数据', () => api.hifox.resetDemo())}>
      重置演示数据
    </Button>
  )
}

export { PageHeader }
