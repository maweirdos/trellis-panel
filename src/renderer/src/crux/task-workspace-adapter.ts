import type { CruxSnapshot, CruxStatusCategory, CruxTask } from '@shared/crux'
import type { MyDataset, StateGroup } from '../my/types'
import { getCruxTaskStageMetadata } from '@shared/crux-domain/workflow'
import { canRestoreLightweightTask } from '@shared/crux-domain/lightweight'
import { statusDisplayName } from './store'

export const CRUX_STATE_GROUPS: Record<CruxStatusCategory, StateGroup> = {
  backlog: 'backlog', todo: 'unstarted', in_progress: 'started', in_review: 'started',
  blocked: 'started', done: 'completed', cancelled: 'cancelled'
}

export function cruxStatusColor(category: CruxStatusCategory): string {
  if (category === 'blocked') return 'var(--my-txt-danger-primary)'
  if (category === 'in_review') return 'var(--my-txt-icon-states-monitoring)'
  return `var(--my-txt-icon-states-${CRUX_STATE_GROUPS[category]})`
}

/** A read projection; collaboration records never enter useMy's native dataset. */
export function deriveTaskWorkspaceDataset(
  snapshot: CruxSnapshot,
  tasks: CruxTask[],
  { spaceId, actorId, workspaceKey, workspaceName }: {
    spaceId: string | null
    actorId: string | null
    workspaceKey: string
    workspaceName?: string | null
  }
): MyDataset {
  const spaces = snapshot.spaces.filter((space) => !spaceId || space.id === spaceId)
  const spaceIds = new Set(spaces.map((space) => space.id))
  const versions = snapshot.iterations.filter((version) => spaceIds.has(version.spaceId))
  const projects = snapshot.projects.filter((project) => spaceIds.has(project.spaceId))
  const referencedPeople = new Set(tasks.flatMap((task) => [...task.assigneeIds, task.creatorId]))
  const people = snapshot.members.filter((member) => !spaceId || referencedPeople.has(member.id) || spaces.some((space) => space.memberIds.includes(member.id)))
  const visibleStage = (task: CruxTask) => task.workflow && !canRestoreLightweightTask(task) && !task.triagePending && snapshot.taskStatuses.find(status => status.id === task.statusId)?.category !== 'cancelled' ? task.workflow.stage : undefined
  const workflowStages = [...new Set(tasks.flatMap(task => { const stage = visibleStage(task); return stage ? [stage] : [] }))]
  const workflowStates = workflowStages.map((stage, index) => { const metadata = getCruxTaskStageMetadata(stage); const group = CRUX_STATE_GROUPS[metadata.category]; return { id: `workflow:${stage}`, name: metadata.label, color: `var(--my-txt-icon-states-${group})`, group, sequence: index } })
  return {
    workspace: { name: workspaceName ?? spaces[0]?.name ?? '团队', slug: workspaceKey, memberId: actorId ?? '' },
    members: people.map((person) => ({
      id: person.id, name: person.name, avatarColor: `hsl(${person.avatarHue} 26% 38%)`,
      role: person.role === 'member' ? 'Member' : 'Admin'
    })),
    projects: spaces.map((space) => ({
      id: space.id, name: space.name, icon: space.name.slice(0, 1), color: 'var(--my-avatar-bg)',
      description: space.description ?? '', cycleEnabled: true, moduleEnabled: true,
      pagesEnabled: false, intakeEnabled: true, memberIds: space.memberIds, leadId: space.ownerId ?? '',
      favorite: false, createdAt: space.createdAt
    })),
    states: [...snapshot.taskStatuses.filter((status) => spaceIds.has(status.spaceId)).map((status) => {
      const group = CRUX_STATE_GROUPS[status.category]
      const label = statusDisplayName(status)
      return {
        id: status.id,
        name: spaceId ? label : `${spaces.find((space) => space.id === status.spaceId)?.key ?? ''} · ${label}`,
        color: cruxStatusColor(status.category),
        group, sequence: status.order
      }
    }), ...workflowStates],
    labels: snapshot.taskLabels.filter((label) => !label.spaceId || spaceIds.has(label.spaceId))
      .map((label) => ({ id: label.id, name: label.name, color: label.color })),
    issues: tasks.map((task) => {
      const dates = versions.filter((version) => task.iterationIds.includes(version.id))
      const stage = visibleStage(task)
      return {
        id: task.id, projectId: task.spaceId, sequenceId: Number(task.id.match(/-(\d+)$/)?.[1] ?? 0),
        name: task.title, description: task.description ?? '', stateId: stage ? `workflow:${stage}` : task.statusId, priority: task.priority,
        assigneeId: task.assigneeIds[0] ?? null, labelIds: task.labelIds,
        cycleId: task.iterationIds[0] ?? null, cycle: task.iterationIds[0] ?? null,
        moduleId: task.projectId ?? null, pkg: projects.find((project) => project.id === task.projectId)?.name ?? null,
        scope: null,
        // These dates are the actual version schedule, labelled as such by TaskWorkspace.
        startDate: dates.map((version) => version.startDate).sort()[0] ?? null,
        dueDate: dates.map((version) => version.endDate).sort().at(-1) ?? null,
        createdAt: task.createdAt, completedAt: task.completedAt ?? null, parentId: task.parentTaskId ?? null,
        subIssueIds: snapshot.tasks.filter((child) => child.parentTaskId === task.id).map((child) => child.id),
        activity: snapshot.activities.filter((event) => event.taskId === task.id)
          .map((event) => ({ id: event.id, actorId: '', verb: event.text, at: event.at })),
        comments: snapshot.comments.filter((comment) => comment.taskId === task.id)
          .map((comment) => ({ id: comment.id, actorId: comment.authorId, body: comment.body, at: comment.createdAt }))
      }
    }),
    cycles: versions.map((version) => ({
      id: version.id, projectId: version.spaceId, name: version.name,
      status: version.status === 'pending' ? 'upcoming' : version.status,
      startDate: version.startDate, endDate: version.endDate, issueIds: version.taskIds
    })),
    modules: projects.map((project) => ({
      id: project.id, projectId: project.spaceId, name: project.name, description: project.goal ?? '',
      status: project.status === 'active' ? 'in-progress' : project.status === 'done' ? 'completed' : 'paused',
      leadId: project.ownerIds[0] ?? '', memberIds: project.ownerIds,
      startDate: '', endDate: '', issueIds: snapshot.tasks.filter((task) => task.projectId === project.id).map((task) => task.id)
    })),
    views: [], pages: [], intake: [], notifications: []
  }
}
