/**
 * 专项：目标聚合一组任务，展示完成度与任务清单（PRD 3.4）。
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { useHifox, statusOf, memberOf } from '../store'
import { PageHeader, Field, inputClass, StatusBadge, MemberChip } from '../ui'
import { Button, EmptyState, Modal } from '../../my/ui'
import type { HifoxProject } from '@shared/hifox'

export function ProjectsPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const openTask = useHifox((s) => s.openTask)
  const setModule = useHifox((s) => s.setModule)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')

  const projects = snapshot.projects.filter((p) => p.spaceId === currentSpaceId)
  const spaceMembers = snapshot.spaces.find((s) => s.id === currentSpaceId)?.memberIds ?? []

  const submit = async (): Promise<void> => {
    if (!currentSpaceId) return
    const result = await run('创建专项', () => api.hifox.createProject({ spaceId: currentSpaceId, name: name.trim(), goal: goal.trim() || undefined }))
    if (result?.ok) { setName(''); setGoal(''); setCreateOpen(false) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="专项"
        description="把一组相关任务收在同一个目标下，跟踪整体推进"
        actions={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建专项</Button>}
      />
      {projects.length === 0
        ? <EmptyState title="暂无专项" description="创建一个专项，把相关任务归入同一目标" />
        : (
          <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2">
            {projects.map((project: HifoxProject) => {
              const tasks = snapshot.tasks.filter((t) => t.projectId === project.id)
              const done = tasks.filter((t) => ['done', 'cancelled'].includes(statusOf(snapshot, t.statusId)?.category ?? '')).length
              const percent = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)
              return (
                <section key={project.id} className="flex flex-col gap-2 rounded-my-md border border-my-line bg-my-layer/40 p-3">
                  <header className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-medium text-my-primary">{project.name}</h2>
                      {project.goal && <p className="mt-0.5 line-clamp-2 text-my-xs text-my-tertiary">{project.goal}</p>}
                    </div>
                    <span className={`shrink-0 rounded-my-sm px-1.5 py-0.5 text-[10px] ${project.status === 'active' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-my-layer text-my-tertiary'}`}>
                      {project.status === 'active' ? '进行中' : project.status === 'done' ? '已完成' : '已归档'}
                    </span>
                  </header>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-my-xs text-my-tertiary">
                      <span>{done} / {tasks.length} 已完成</span>
                      <span>{percent}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-my-layer-active">
                      <div className="h-full rounded-full bg-emerald-500/70 transition-all" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                  {project.ownerIds.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-my-xs text-my-tertiary">负责：</span>
                      {project.ownerIds.map((id) => <MemberChip key={id} member={memberOf(snapshot, id)} size="sm" />)}
                    </div>
                  )}
                  <ul className="my-scrollbar max-h-40 space-y-1 overflow-y-auto">
                    {tasks.slice(0, 8).map((task) => (
                      <li key={task.id}>
                        <button type="button" className="flex w-full items-center gap-2 rounded-my-sm px-1.5 py-1 text-left text-my-xs hover:bg-my-layer"
                          onClick={() => { openTask(task.id); setModule('tasks') }}>
                          <span className="shrink-0 font-mono text-[10px] text-my-tertiary">{task.id}</span>
                          <span className="min-w-0 flex-1 truncate text-my-secondary">{task.title}</span>
                          <StatusBadge status={statusOf(snapshot, task.statusId)} />
                        </button>
                      </li>
                    ))}
                    {tasks.length === 0 && <li className="px-1 py-2 text-my-xs text-my-tertiary">还没有任务归属这个专项</li>}
                  </ul>
                  {project.status === 'active' && (
                    <div className="flex justify-end gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => void run('完成专项', () => api.hifox.updateProject({ id: project.id, status: 'done' }))}>标记完成</Button>
                      <Button variant="ghost" size="sm" onClick={() => void run('归档专项', () => api.hifox.updateProject({ id: project.id, status: 'archived' }))}>归档</Button>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} width={420} ariaLabel="新建专项">
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-semibold text-my-primary">新建专项</h2>
          <Field label="名称">
            <input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：协作面板升级" />
          </Field>
          <Field label="目标">
            <textarea className={`${inputClass} min-h-16 resize-y`} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="这一件事整体要达成什么" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" size="sm" disabled={!name.trim()} onClick={() => void submit()}>创建</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
