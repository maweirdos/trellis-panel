import { useState } from 'react'
import { formatCollaborationTime } from '../ui'
import { ArrowRight, Bot, Plus } from 'lucide-react'
import { isTriagePending, useHifox, spaceTasks, statusOf } from '../store'
import { PageHeader, StatusBadge, selectSnapshotCount, MemberChip } from '../ui'
import { FlowIcon } from '../icons'
import { Button, EmptyState } from '../../my/ui'
import { SpaceEditor } from './SpacesPage'



export function OverviewPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)
  const spaceId = useHifox((s) => s.currentSpaceId)
  const setModule = useHifox((s) => s.setModule)
  const openTask = useHifox((s) => s.openTask)
  const canManage = useHifox((s) => s.workspaceContext.canManage)
  const context = useHifox((s) => s.workspaceContext)
  const [creatingSpace, setCreatingSpace] = useState(false)
  if (!snapshot) return <></>
  const space = snapshot.spaces.find((s) => s.id === spaceId)
  if (!space) return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader title="协作概览" />
    <div className="my-scrollbar flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto" aria-label="空间为空">
      <EmptyState title={canManage ? '还没有空间' : '还没有加入空间'} />
      <div className="-mt-8 mb-8 flex flex-wrap items-center justify-center gap-2">
        {canManage && <Button variant="primary" onClick={() => setCreatingSpace(true)}>创建空间</Button>}
        <Button variant={canManage ? 'outline' : 'primary'} onClick={() => setModule('spaces')}>浏览空间</Button>
      </div>
    </div>
    {creatingSpace && canManage && <SpaceEditor onClose={() => setCreatingSpace(false)} />}
  </div>
  const tasks = spaceTasks(snapshot, space.id)
  const counts = selectSnapshotCount(snapshot, space.id)
  const activeVersions = snapshot.iterations.filter((it) => it.spaceId === space.id && it.status === 'active')
  const pendingVersions = snapshot.iterations.filter((it) => it.spaceId === space.id && it.status === 'pending')
  const actor = context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  const canCreateTask = Boolean(actor && !space.archived && space.memberIds.includes(actor) && (context.state === 'local' || context.state === 'connected'))
  const attention = tasks.filter((task) => ['blocked', 'in_review'].includes(statusOf(snapshot, task.statusId)?.category ?? ''))
  const activities = snapshot.activities.filter((a) => tasks.some((t) => t.id === a.taskId)).slice(0, 6)
  const triage = tasks.filter((t) => isTriagePending(snapshot, t)).length
  return <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
    <PageHeader title={`${space.name} · 协作概览`} description={space.description} actions={canCreateTask ? <Button variant="primary" size="sm" onClick={() => useHifox.getState().beginCreateTask({ spaceId: space.id })}><Plus size={14} />新建任务</Button> : undefined} />
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[{ label: '全部任务', value: counts.tasks, detail: `已完成 ${counts.done}`, icon: 'tasks' as const, go: 'tasks' as const }, { label: '待分拣', value: triage, detail: null, icon: 'triage' as const, go: 'triage' as const }, { label: '进行中版本', value: activeVersions.length, detail: pendingVersions.length ? `待开始 ${pendingVersions.length}` : null, icon: 'iterations' as const, go: 'iterations' as const }, { label: '空间成员', value: counts.members, detail: counts.agents ? <span className="inline-flex items-center gap-1"><Bot size={13} />{counts.agents}</span> : null, icon: 'members' as const, go: 'members' as const }].map((card) => <button key={card.label} type="button" onClick={() => setModule(card.go)} className="flex min-w-0 flex-col gap-2 rounded-my-md bg-my-layer-1 p-3 text-left hover:bg-my-layer-1-hover"><span className="flex items-center gap-2 text-my-xs text-my-secondary"><FlowIcon name={card.icon} size={18} />{card.label}</span><strong className="collab-stat text-my-xl text-my-primary">{card.value}</strong>{card.detail && <span className="truncate text-my-xs text-my-tertiary">{card.detail}</span>}</button>)}
    </div>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="rounded-my-md border border-my-line p-4"><h2 className="mb-3 flex items-center gap-2 text-my-sm font-medium text-my-primary"><FlowIcon name="review" size={18} />需要团队关注<span className="ml-auto text-my-xs text-my-tertiary">{attention.length}</span></h2>
        {attention.length === 0 ? <p className="text-my-xs text-my-tertiary">暂无受阻或等待评审的任务。</p> : <ul className="space-y-1">{attention.slice(0, 6).map((task) => <li key={task.id}><button type="button" onClick={() => openTask(task.id)} className="flex w-full items-center gap-2 rounded-my-md py-2 text-left hover:bg-my-layer-transparent-hover"><span className="font-mono text-my-2xs text-my-tertiary">{task.id}</span><span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">{task.title}</span><StatusBadge status={statusOf(snapshot, task.statusId)} /></button></li>)}</ul>}
      </section>
      <section className="rounded-my-md border border-my-line p-4"><h2 className="mb-3 flex items-center gap-2 text-my-sm font-medium text-my-primary"><FlowIcon name="activity" size={18} />最近协作记录</h2>
        {activities.length === 0 ? <p className="text-my-xs text-my-tertiary">暂无动态</p> : <ul className="space-y-3">{activities.map((activity) => <li key={activity.id} className="flex items-start gap-2 text-my-xs"><button type="button" onClick={() => openTask(activity.taskId)} className="shrink-0 font-mono text-my-secondary hover:underline">{activity.taskId}</button><span className="min-w-0 flex-1 break-words text-my-secondary">{activity.text}</span><span className="shrink-0 text-my-tertiary">{formatCollaborationTime(activity.at)}</span></li>)}</ul>}
      </section>
    </div>
    <section className="flex flex-wrap items-center gap-3 border-t border-my-line pt-3"><span className="text-my-xs text-my-tertiary">空间同事</span>{space.memberIds.map((id) => <MemberChip key={id} member={snapshot.members.find((m) => m.id === id)} />)}<button type="button" onClick={() => setModule('members')} className="ml-auto inline-flex items-center gap-1 text-my-xs text-my-secondary hover:underline">管理同事<ArrowRight size={13} /></button></section>
  </div>
}
