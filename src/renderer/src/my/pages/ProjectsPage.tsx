// 项目页（R10）：全部项目卡片网格 + 新建项目入口。
import { type JSX } from 'react'
import { Plus, Star } from 'lucide-react'
import { useMy } from '../store'
import { Avatar, AvatarStack, Button, TriProgressBar } from '../ui'
import { WorkspaceMark } from '../icons'
import type { Issue, Member, Project, WorkItemState } from '../types'

/* ---------------- 项目卡片 ---------------- */

function ProjectCard({
  project,
  issues,
  cycleCount,
  members,
  states,
  lead,
  onOpen
}: {
  project: Project
  issues: Issue[]
  cycleCount: number
  members: Member[]
  states: Map<string, WorkItemState>
  lead: Member | undefined
  onOpen: (id: string) => void
}): JSX.Element {
  const groupOf = (i: Issue): string | undefined => states.get(i.stateId)?.group
  // 迷你堆叠条只统计未取消的工作项，避免已取消把轨道撑长
  const tracked = issues.filter((i) => groupOf(i) !== 'cancelled').length
  const done = issues.filter((i) => groupOf(i) === 'completed').length
  const started = issues.filter((i) => groupOf(i) === 'started').length

  return (
    <div
      onClick={() => onOpen(project.id)}
      className="my-card cursor-pointer p-4"
      role="button"
    >
      <div className="flex items-center gap-2.5">
        <WorkspaceMark color={project.color} letter={project.icon.slice(0, 1)} size={28} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-my-primary">{project.name}</span>
        {project.favorite && <Star size={14} className="shrink-0 fill-current text-my-warning" />}
      </div>

      <p className="mt-2 line-clamp-2 min-h-[32px] text-[12px] leading-4 text-my-tertiary">{project.description}</p>

      <div className="mt-3 text-[11.5px] text-my-tertiary">
        {issues.length} 个工作项 · {cycleCount} 个周期
      </div>

      <div className="mt-2">
        <TriProgressBar done={done} started={started} total={tracked} />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <AvatarStack members={members} size={20} />
        {lead && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-my-tertiary">
            <Avatar name={lead.name} color={lead.avatarColor} size={16} />
            <span className="truncate">{lead.name}</span>
          </span>
        )}
      </div>
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function ProjectsPage(): JSX.Element {
  const { data, navigateProject, setCreateProjectOpen } = useMy()

  const members = new Map<string, Member>(data.members.map((m) => [m.id, m]))
  const states = new Map<string, WorkItemState>(data.states.map((s) => [s.id, s]))

  return (
    <div className="px-8 pb-16 pt-6">
      {/* 顶栏 */}
      <div className="flex items-center justify-between pb-4">
        <h1 className="text-[20px] font-semibold text-my-primary">Projects</h1>
        <Button variant="primary" onClick={() => setCreateProjectOpen(true)}>
          <Plus size={14} />
          New project
        </Button>
      </div>

      {/* 全宽项目网格 */}
      <div className="grid grid-cols-3 gap-3">
        {data.projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            issues={data.issues.filter((i) => i.projectId === p.id)}
            cycleCount={data.cycles.filter((c) => c.projectId === p.id).length}
            members={p.memberIds.flatMap((id) => {
              const m = members.get(id)
              return m ? [m] : []
            })}
            states={states}
            lead={members.get(p.leadId)}
            onOpen={navigateProject}
          />
        ))}
      </div>
    </div>
  )
}
