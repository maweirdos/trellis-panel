import { useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react'
import { useCrux } from '../store'
import { WORKFLOW_ACTION_LABELS } from '../TaskWorkflow'
import { PriorityBadge, formatCollaborationTime } from '../ui'
import { Button } from '../../my/ui'
import { hasLocalWorkBridge } from '../local-work'
import { cockpitActor, localCalendarDate, NEXT_STEP_GROUPS, nextSteps, taskInsights } from './model'
import { useCockpitGeneration, useCockpitOwner } from './use-cockpit-owner'

export function MyNextSteps({ spaceId, iterationId }: { spaceId?: string; iterationId?: string } = {}): JSX.Element {
  const generation = useCockpitGeneration(Boolean(spaceId))
  return <MyNextStepsSource key={generation} spaceId={spaceId} iterationId={iterationId} />
}

function MyNextStepsSource({ spaceId, iterationId }: { spaceId?: string; iterationId?: string }): JSX.Element | null {
  const { snapshot, workspaceContext } = useCrux()
  const owns = useCockpitOwner(Boolean(spaceId))
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const items = useMemo(() => snapshot ? nextSteps(taskInsights(snapshot, workspaceContext), localCalendarDate()).filter((item) =>
    (!spaceId || item.task.spaceId === spaceId) && (!iterationId || item.task.iterationIds.includes(iterationId))) : [], [snapshot, workspaceContext, spaceId, iterationId])
  // Preserve row order during snapshot refreshes; new work appears after existing visible rows.
  const [order] = useState(() => items.map((item) => item.task.id))
  if (!snapshot) return null
  const actor = cockpitActor(snapshot, workspaceContext)
  const open = (id: string, createdAt: string): void => {
    if (!owns()) return
    const current = useCrux.getState()
    const task = current.snapshot?.tasks.find((entry) => entry.id === id && entry.createdAt === createdAt)
    if (task && current.snapshot && taskInsights(current.snapshot, current.workspaceContext).some((entry) => entry.task.id === id && entry.group)) current.openTask(id)
  }
  const limit = expanded ? items.length : 3
  const create = (): void => {
    if (!owns() || !actor) return
    const state = useCrux.getState()
    const target = state.snapshot?.spaces.find((space) => space.id === (spaceId ?? state.currentSpaceId) && !space.archived && space.memberIds.includes(actor))
    if (target) state.beginCreateTask({ spaceId: target.id })
  }
  return <section aria-label="我的下一步" className="shrink-0 border-b border-my-line bg-my-canvas">
    <div className="my-page-toolbar-row flex flex-wrap items-center gap-2 py-2">
      <button type="button" aria-expanded={!collapsed} onClick={() => { if (owns()) setCollapsed((value) => !value) }} className="my-control flex items-center gap-2 rounded-my-md px-2 py-1 text-my-sm font-medium text-my-primary">
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}我的下一步<span className="text-my-xs font-normal text-my-tertiary">{items.length}</span>
      </button>
      <span className="ml-auto text-my-2xs text-my-tertiary">{workspaceContext.state === 'offline' ? '离线缓存 · 恢复连接后核对' : '当前可见空间'} · 完整任务列表在下方</span>
    </div>
    {!collapsed && <div className="my-page-toolbar-row max-h-80 overflow-y-auto pb-3 my-scrollbar" style={{ scrollbarGutter: 'stable' }}>
      {!actor ? <p className="text-my-xs text-my-tertiary">尚未确认当前成员身份</p> : items.length === 0 ? <div className="flex flex-wrap items-center gap-3 py-3"><p className="text-my-sm text-my-secondary">当前没有待处理事项</p><Button size="sm" variant="outline" onClick={() => { if (owns()) useCrux.getState().setModule('tasks') }}>查看空间任务</Button><Button size="sm" variant="ghost" disabled={!snapshot.spaces.some((space) => space.id === (spaceId ?? useCrux.getState().currentSpaceId) && !space.archived && space.memberIds.includes(actor)) || workspaceContext.state === 'offline'} onClick={create}>新建任务</Button></div> : NEXT_STEP_GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group.id).sort((a, b) => {
          const ai = order.indexOf(a.task.id); const bi = order.indexOf(b.task.id)
          return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi)
        })
        if (!groupItems.length) return null
        return <div key={group.id} className="mb-3 last:mb-0"><h3 className="mb-1 flex items-center gap-2 text-my-xs font-medium text-my-secondary">{group.label}<span className="font-normal text-my-tertiary">{groupItems.length}</span></h3>
          <ul className="divide-y divide-my-line">{groupItems.slice(0, limit).map((item) => {
            const desktopRequired = item.action === 'begin_development' && !hasLocalWorkBridge()
            const actionLabel = item.action && item.canAct && !desktopRequired ? WORKFLOW_ACTION_LABELS[item.action] : '查看任务'
            const handler = snapshot.members.find((member) => member.id === item.handlerId)?.name ?? (item.handlerId ? '原处理人不可用' : '未指派')
            return <li key={item.task.id} className="flex min-w-0 flex-wrap items-start gap-3 py-2" data-next-step={group.id}>
              <div className="min-w-0 flex-1"><button type="button" onClick={() => open(item.task.id, item.task.createdAt)} className="max-w-full break-words text-left text-my-sm font-medium text-my-primary hover:underline"><span className="mr-2 font-mono text-my-2xs text-my-tertiary">{item.task.id}</span>{item.task.title}</button>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-my-2xs text-my-tertiary"><span>{snapshot.spaces.find((space) => space.id === item.task.spaceId)?.name}</span><span>{item.stage}</span><span>处理人 · {handler}</span><span>最后确认 {formatCollaborationTime(item.lastConfirmedAt)}</span>{item.deadline && <span>版本截止 {item.deadline}</span>}</div>
                {(item.waiting || item.missing.length > 0 || desktopRequired) && <p className="mt-1 break-words text-my-xs text-my-secondary">{[item.waiting, ...item.missing, desktopRequired ? '技术规划需在桌面端准备本机任务' : null].filter(Boolean).join(' · ')}</p>}
              </div><div className="flex shrink-0 items-center gap-2"><PriorityBadge priority={item.task.priority} /><Button size="sm" variant="outline" aria-label={`${actionLabel} ${item.task.id}`} onClick={() => open(item.task.id, item.task.createdAt)}>{actionLabel}<ArrowRight size={13} /></Button></div>
            </li>
          })}</ul>
        </div>
      })}
      {items.some((item) => items.filter((candidate) => candidate.group === item.group).length > 3) && <Button size="sm" variant="ghost" onClick={() => { if (owns()) setExpanded((value) => !value) }}>{expanded ? '收起事项' : '展开全部事项'}</Button>}
    </div>}
  </section>
}
